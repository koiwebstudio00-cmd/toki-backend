// Menú público, cupón, checkout y seguimiento — docs/api.md §13.
//
// Contextos: las lecturas van como `anon` (las policies públicas ya filtran
// negocio activo, categorías activas y productos disponibles). El checkout va
// como `service_role` porque escribe cliente, pedido, stock y cupón, igual que
// hacía la Edge Function con la service key.
import type { Prisma } from "@prisma/client";
import { anonCtx, systemCtx, type Tx, withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import { dateToString, timeToString } from "../../lib/time.js";
import { isOpen } from "../businesses/service.js";
import { buildOrderPayload, calculateDiscount, persistOrder, validateCoupon } from "../orders/pricing.js";
import type { CheckoutInput, ValidateCouponInput } from "./schemas.js";

const SPECIAL_HOURS_DAYS = 14;

/** Producto como lo ve un cliente final: sin stock, sin costos, sin barcode. */
const publicProductInclude = {
  options: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { values: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } }
  }
} satisfies Prisma.ProductInclude;

type PublicProductRow = Prisma.ProductGetPayload<{ include: typeof publicProductInclude }>;

function toPublicProduct(p: PublicProductRow) {
  return {
    id: p.id,
    categoryId: p.categoryId,
    name: p.name,
    description: p.description,
    price: toNumber(p.price),
    imageUrl: p.imageUrl,
    isFeatured: p.isFeatured,
    preparationMinutes: p.preparationMinutes,
    sortOrder: p.sortOrder,
    options: p.options.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type as "single" | "multiple",
      isRequired: o.isRequired,
      minSelect: o.minSelect,
      maxSelect: o.maxSelect,
      // Los valores sin stock o pausados no se ofrecen: el carrito no puede
      // armarse con algo que después el checkout va a rechazar.
      values: o.values
        .filter((v) => v.isAvailable && (!v.trackStock || v.stockQuantity > 0))
        .map((v) => ({ id: v.id, name: v.name, priceDelta: toNumber(v.priceDelta) }))
    }))
  };
}

async function findActiveBusiness(tx: Tx, slug: string) {
  const business = await tx.business.findFirst({ where: { slug, isActive: true } });
  if (!business) throw notFound("No encontramos este menú. Revisá el link o volvé a intentarlo.");
  return business;
}

const availableProducts = { isAvailable: true, OR: [{ trackStock: false }, { stockQuantity: { gt: 0 } }] };

/**
 * Todo lo que el menú y el checkout necesitan, en una sola request: hoy el
 * front hace seis consultas a Supabase para esta misma pantalla.
 */
export async function getMenu(slug: string) {
  return withDb(anonCtx, async (tx) => {
    const business = await findActiveBusiness(tx, slug);
    const today = new Date();
    const until = new Date(today.getTime() + SPECIAL_HOURS_DAYS * 24 * 3_600_000);

    const [open, hours, specialHours, categories, products, payment, loyalty] = await Promise.all([
      isOpen(tx, business.id),
      tx.businessHour.findMany({ where: { businessId: business.id }, orderBy: { dayOfWeek: "asc" } }),
      tx.businessSpecialHour.findMany({
        where: { businessId: business.id, date: { gte: startOfDay(today), lte: until } },
        orderBy: { date: "asc" }
      }),
      tx.category.findMany({
        where: { businessId: business.id, isActive: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, name: true, description: true, imageUrl: true, sortOrder: true }
      }),
      tx.product.findMany({
        where: { businessId: business.id, ...availableProducts },
        include: publicProductInclude,
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
      }),
      tx.paymentSettings.findUnique({ where: { businessId: business.id } }),
      tx.loyaltySettings.findUnique({ where: { businessId: business.id } })
    ]);

    return {
      business: {
        id: business.id,
        name: business.name,
        slug: business.slug,
        description: business.description,
        logoUrl: business.logoUrl,
        coverUrl: business.coverUrl,
        phone: business.phone,
        whatsappPhone: business.whatsappPhone,
        address: business.address,
        city: business.city,
        currency: business.currency,
        timezone: business.timezone,
        estimatedDeliveryMinutes: business.estimatedDeliveryMinutes,
        minimumOrderAmount: toNumber(business.minimumOrderAmount),
        deliveryFee: toNumber(business.deliveryFee)
      },
      isOpen: open,
      hours: hours.map((h) => ({
        dayOfWeek: h.dayOfWeek,
        isOpen: h.isOpen,
        opensAt: timeToString(h.opensAt),
        closesAt: timeToString(h.closesAt),
        opensAt2: timeToString(h.opensAt2),
        closesAt2: timeToString(h.closesAt2)
      })),
      specialHours: specialHours.map((h) => ({
        date: dateToString(h.date)!,
        isClosed: h.isClosed,
        opensAt: timeToString(h.opensAt),
        closesAt: timeToString(h.closesAt),
        note: h.note
      })),
      categories,
      products: products.map(toPublicProduct),
      paymentMethods: {
        cash: payment?.cashEnabled ?? true,
        transfer: payment?.transferEnabled ?? true,
        // Los datos de transferencia solo si ese medio está habilitado.
        ...(payment?.transferEnabled
          ? {
              transferDetails: {
                cbu: payment.transferCbu,
                alias: payment.transferAlias,
                holder: payment.transferHolder,
                bank: payment.transferBank
              }
            }
          : {})
      },
      loyalty: {
        isEnabled: loyalty?.isEnabled ?? false,
        pointsPerCurrency: toNumber(loyalty?.pointsPerCurrency ?? 0),
        pointsPerOrder: loyalty?.pointsPerOrder ?? 0,
        redeemRate: toNumber(loyalty?.redeemRate ?? 0),
        minPointsToRedeem: loyalty?.minPointsToRedeem ?? 0
      }
    };
  });
}

function startOfDay(date: Date): Date {
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00Z`);
}

export async function getProduct(slug: string, id: string) {
  return withDb(anonCtx, async (tx) => {
    const business = await findActiveBusiness(tx, slug);
    const product = await tx.product.findFirst({
      where: { id, businessId: business.id, ...availableProducts },
      include: publicProductInclude
    });
    if (!product) throw notFound("Este producto ya no está disponible.");
    return toPublicProduct(product);
  });
}

/**
 * Contexto `service_role`: las policies públicas de `coupons` no le muestran a
 * `anon` los cupones vencidos ni los que agotaron sus usos, y el cliente tiene
 * que enterarse del motivo real en vez de "no existe".
 */
export async function validatePublicCoupon(slug: string, input: ValidateCouponInput) {
  return withDb(systemCtx, async (tx) => {
    const business = await findActiveBusiness(tx, slug);
    const coupon = await validateCoupon(tx, business.id, input.code, input.subtotal);
    return {
      valid: true as const,
      code: coupon.code,
      discountType: coupon.discountType as "percent" | "fixed",
      discountValue: toNumber(coupon.discountValue),
      discountTotal: calculateDiscount(coupon, input.subtotal)
    };
  });
}

/**
 * Checkout. Mismo orden de validaciones que la Edge Function `create-order`:
 * negocio activo → negocio abierto → precios y stock → persist_order.
 * El NOTIFY para los dashboards lo emite el trigger de la migración 0003.
 */
export async function createOrder(slug: string, input: CheckoutInput) {
  return withDb(systemCtx, async (tx) => {
    const business = await tx.business.findFirst({ where: { slug, isActive: true } });
    if (!business) throw notFound("No encontramos este menú. Revisá el link o volvé a intentarlo.");
    if (!(await isOpen(tx, business.id))) {
      throw new ApiError(
        "BUSINESS_CLOSED",
        "El negocio está cerrado en este momento. Probá nuevamente en el próximo horario de atención."
      );
    }
    const payload = await buildOrderPayload(tx, business, input);
    return persistOrder(tx, { ...payload, source: "web" });
  });
}

/** Seguimiento por código. `get_public_order` no devuelve datos privados. */
export async function trackOrder(slug: string, code: string) {
  return withDb(anonCtx, async (tx) => {
    const rows = await tx.$queryRaw<{ result: Record<string, unknown> | null }[]>`
      select public.get_public_order(${code.toUpperCase()}) as result`;
    const order = rows[0]?.result;
    // Un pedido de otro negocio con el mismo link es un 404, no un pedido ajeno.
    if (!order || order.business_slug !== slug) throw notFound("No encontramos ese pedido. Revisá el código.");
    return order;
  });
}
