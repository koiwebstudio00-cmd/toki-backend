// Negocio actual, estado, horarios y checklist. docs/api.md §4.
import type { Prisma } from "@prisma/client";
import { type DbCtx, type Tx, withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { mapDbError } from "../../middleware/error.js";
import { toNumber } from "../../lib/money.js";
import { DEFAULT_ASSET_PREFIX, deleteReplacedImage, isAllowedImageUrl } from "../../lib/r2.js";
import type { BusinessScope } from "../../lib/request.js";
import { dateFromString, dateToString, timeFromString, timeToString } from "../../lib/time.js";
import type { CreateBusinessInput, HoursInput, SpecialHoursInput, UpdateBusinessInput } from "./schemas.js";

type BusinessRow = Prisma.BusinessGetPayload<object>;

export function toBusinessDto(b: BusinessRow, isOpen?: boolean) {
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    description: b.description,
    businessType: b.businessType,
    logoUrl: b.logoUrl,
    coverUrl: b.coverUrl,
    phone: b.phone,
    whatsappPhone: b.whatsappPhone,
    address: b.address,
    city: b.city,
    country: b.country,
    currency: b.currency,
    timezone: b.timezone,
    estimatedDeliveryMinutes: b.estimatedDeliveryMinutes,
    minimumOrderAmount: toNumber(b.minimumOrderAmount),
    deliveryFee: toNumber(b.deliveryFee),
    isActive: b.isActive,
    manualStatus: b.manualStatus as "auto" | "open" | "closed",
    ...(isOpen === undefined ? {} : { isOpen }),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt
  };
}

export async function isOpen(tx: Tx, businessId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ open: boolean }[]>`select public.business_is_open(${businessId}::uuid) as open`;
  return Boolean(rows[0]?.open);
}

// ── Alta ────────────────────────────────────────────────────────────────────

export async function createWithOwner(ctx: DbCtx, input: CreateBusinessInput) {
  return withDb(ctx, async (tx) => {
    // La función crea negocio, owner, bot y horarios. El slug repetido lo frena
    // el UNIQUE (no se puede chequear antes: RLS oculta negocios inactivos ajenos).
    const rows = await tx.$queryRaw<{ id: string }[]>`
      select public.create_business_with_owner(
        ${input.name}, ${input.slug}, ${input.phone ?? null}, ${input.address ?? null},
        ${input.city ?? null}, ${input.description ?? null}
      ) as id`;
    const id = rows[0]!.id;
    // Efectivo y transferencia habilitados por defecto (mismos defaults que la tabla).
    await tx.paymentSettings.create({ data: { businessId: id } });
    return { id, slug: input.slug };
  }).catch((err: unknown) => {
    if (isUniqueViolation(err)) throw new ApiError("CONFLICT", "Ese link ya está en uso. Probá con otro.");
    throw err;
  });
}

function isUniqueViolation(err: unknown): boolean {
  return mapDbError(err)?.code === "CONFLICT";
}

// ── Negocio actual ──────────────────────────────────────────────────────────

export async function getCurrent({ ctx, businessId }: BusinessScope) {
  return withDb(ctx, async (tx) => {
    const b = await tx.business.findUnique({ where: { id: businessId } });
    if (!b) throw notFound("No encontramos el negocio.");
    return toBusinessDto(b, await isOpen(tx, businessId));
  });
}

export async function update({ ctx, businessId }: BusinessScope, input: UpdateBusinessInput) {
  for (const field of ["logoUrl", "coverUrl"] as const) {
    if (!isAllowedImageUrl(input[field], businessId)) {
      throw new ApiError("VALIDATION_ERROR", "La imagen no es válida. Subila de nuevo.", [
        { field, message: "Usá una imagen subida desde Toki." }
      ]);
    }
  }

  const { previous, next } = await withDb(ctx, async (tx) => {
    const prev = await tx.business.findUnique({ where: { id: businessId }, select: { logoUrl: true, coverUrl: true } });
    if (!prev) throw notFound("No encontramos el negocio.");
    const { count } = await tx.business.updateMany({ where: { id: businessId }, data: input });
    if (count === 0) throw new ApiError("FORBIDDEN", "Tu rol no permite editar el negocio.");
    const b = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
    return { previous: prev, next: toBusinessDto(b, await isOpen(tx, businessId)) };
  }).catch((err: unknown) => {
    if (isUniqueViolation(err)) throw new ApiError("CONFLICT", "Ese link ya está en uso. Probá con otro.");
    throw err;
  });

  // Después del commit: limpiar imágenes reemplazadas. Los defaults del front
  // (/defaults/...) no son del bucket y deleteReplacedImage los ignora.
  if (input.logoUrl !== undefined) await deleteReplacedImage(previous.logoUrl, next.logoUrl);
  if (input.coverUrl !== undefined) await deleteReplacedImage(previous.coverUrl, next.coverUrl);
  return next;
}

export async function setManualStatus({ ctx, businessId }: BusinessScope, manualStatus: "auto" | "open" | "closed") {
  return withDb(ctx, async (tx) => {
    const { count } = await tx.business.updateMany({ where: { id: businessId }, data: { manualStatus } });
    if (count === 0) throw new ApiError("FORBIDDEN", "Tu rol no permite cambiar el estado del negocio.");
    return { manualStatus, isOpen: await isOpen(tx, businessId) };
  });
}

// ── Horarios ────────────────────────────────────────────────────────────────

type HourRow = Prisma.BusinessHourGetPayload<object>;

function toHourDto(h: HourRow) {
  return {
    dayOfWeek: h.dayOfWeek,
    isOpen: h.isOpen,
    opensAt: timeToString(h.opensAt),
    closesAt: timeToString(h.closesAt),
    opensAt2: timeToString(h.opensAt2),
    closesAt2: timeToString(h.closesAt2)
  };
}

export async function getHours({ ctx, businessId }: BusinessScope) {
  const rows = await withDb(ctx, (tx) =>
    tx.businessHour.findMany({ where: { businessId }, orderBy: { dayOfWeek: "asc" } })
  );
  return rows.map(toHourDto);
}

export async function replaceHours({ ctx, businessId }: BusinessScope, hours: HoursInput) {
  const rows = await withDb(ctx, async (tx) => {
    for (const h of hours) {
      const data = {
        isOpen: h.isOpen,
        opensAt: h.isOpen ? timeFromString(h.opensAt) : null,
        closesAt: h.isOpen ? timeFromString(h.closesAt) : null,
        opensAt2: h.isOpen ? timeFromString(h.opensAt2) : null,
        closesAt2: h.isOpen ? timeFromString(h.closesAt2) : null
      };
      await tx.businessHour.upsert({
        where: { businessId_dayOfWeek: { businessId, dayOfWeek: h.dayOfWeek } },
        create: { businessId, dayOfWeek: h.dayOfWeek, ...data },
        update: data
      });
    }
    return tx.businessHour.findMany({ where: { businessId }, orderBy: { dayOfWeek: "asc" } });
  });
  return rows.map(toHourDto);
}

type SpecialRow = Prisma.BusinessSpecialHourGetPayload<object>;

function toSpecialDto(h: SpecialRow) {
  return {
    id: h.id,
    date: dateToString(h.date)!,
    isClosed: h.isClosed,
    opensAt: timeToString(h.opensAt),
    closesAt: timeToString(h.closesAt),
    note: h.note
  };
}

export async function listSpecialHours({ ctx, businessId }: BusinessScope, from?: string) {
  const rows = await withDb(ctx, (tx) =>
    tx.businessSpecialHour.findMany({
      where: { businessId, ...(from ? { date: { gte: dateFromString(from) } } : {}) },
      orderBy: { date: "asc" }
    })
  );
  return rows.map(toSpecialDto);
}

/** Reemplaza todos los horarios especiales del negocio (igual que el front hoy). */
export async function replaceSpecialHours({ ctx, businessId }: BusinessScope, specialHours: SpecialHoursInput) {
  const rows = await withDb(ctx, async (tx) => {
    await tx.businessSpecialHour.deleteMany({ where: { businessId } });
    if (specialHours.length) {
      await tx.businessSpecialHour.createMany({
        data: specialHours.map((h) => ({
          businessId,
          date: dateFromString(h.date),
          isClosed: h.isClosed,
          opensAt: h.isClosed ? null : timeFromString(h.opensAt),
          closesAt: h.isClosed ? null : timeFromString(h.closesAt),
          note: h.note ?? null
        }))
      });
    }
    return tx.businessSpecialHour.findMany({ where: { businessId }, orderBy: { date: "asc" } });
  });
  return rows.map(toSpecialDto);
}

export async function deleteSpecialHour({ ctx, businessId }: BusinessScope, id: string) {
  const { count } = await withDb(ctx, (tx) => tx.businessSpecialHour.deleteMany({ where: { id, businessId } }));
  if (count === 0) throw notFound("El horario especial no existe.");
}

// ── Checklist de primeros pasos ─────────────────────────────────────────────

export async function getChecklist({ ctx, businessId }: BusinessScope) {
  return withDb(ctx, async (tx) => {
    const [b, openDays, payment, activeCategories, availableProducts, whatsapp] = await Promise.all([
      tx.business.findUnique({ where: { id: businessId }, select: { slug: true, logoUrl: true, coverUrl: true, deliveryFee: true, minimumOrderAmount: true, isActive: true } }),
      tx.businessHour.count({ where: { businessId, isOpen: true } }),
      tx.paymentSettings.findUnique({ where: { businessId }, select: { cashEnabled: true, transferEnabled: true, mercadopagoEnabled: true } }),
      tx.category.count({ where: { businessId, isActive: true } }),
      tx.product.count({ where: { businessId, isAvailable: true } }),
      tx.whatsappIntegration.findFirst({ where: { businessId, isActive: true }, select: { id: true } })
    ]);
    if (!b) throw notFound("No encontramos el negocio.");

    const hasLogo = Boolean(b.logoUrl && !b.logoUrl.startsWith(DEFAULT_ASSET_PREFIX));
    const hasCover = Boolean(b.coverUrl && !b.coverUrl.startsWith(DEFAULT_ASSET_PREFIX));
    const hasPaymentMethod = Boolean(payment?.cashEnabled || payment?.transferEnabled || payment?.mercadopagoEnabled);
    const items = {
      hasLogo,
      hasCover,
      hasHours: openDays > 0,
      hasPaymentMethod,
      hasCategories: activeCategories > 0,
      hasProducts: availableProducts > 0,
      whatsappConnected: Boolean(whatsapp)
    };
    return {
      slug: b.slug,
      isActive: b.isActive,
      deliveryFee: toNumber(b.deliveryFee),
      minimumOrderAmount: toNumber(b.minimumOrderAmount),
      openDays,
      activeCategories,
      availableProducts,
      ...items,
      completed: Object.values(items).every(Boolean)
    };
  });
}
