// Cupones. docs/api.md §6.
import type { Prisma } from "@prisma/client";
import { withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import type { BusinessScope } from "../../lib/request.js";
import { mapDbError } from "../../middleware/error.js";
import type { CreateCouponInput, UpdateCouponInput } from "./schemas.js";

type CouponRow = Prisma.CouponGetPayload<object>;

export function toCouponDto(c: CouponRow) {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    discountType: c.discountType as "percent" | "fixed",
    discountValue: toNumber(c.discountValue),
    minimumOrderAmount: toNumber(c.minimumOrderAmount),
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    usageLimit: c.usageLimit,
    usedCount: c.usedCount,
    isActive: c.isActive,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  };
}

const duplicate = (err: unknown) => {
  if (mapDbError(err)?.code === "CONFLICT") throw new ApiError("CONFLICT", "Ya tenés un cupón con ese código.");
  throw err;
};

export async function list({ ctx, businessId }: BusinessScope) {
  const rows = await withDb(ctx, (tx) =>
    tx.coupon.findMany({ where: { businessId }, orderBy: [{ isActive: "desc" }, { createdAt: "desc" }] })
  );
  return rows.map(toCouponDto);
}

export async function create({ ctx, businessId }: BusinessScope, input: CreateCouponInput) {
  const row = await withDb(ctx, (tx) => tx.coupon.create({ data: { businessId, ...input } })).catch(duplicate);
  return toCouponDto(row);
}

export async function update({ ctx, businessId }: BusinessScope, id: string, input: UpdateCouponInput) {
  const row = await withDb(ctx, async (tx) => {
    const current = await tx.coupon.findFirst({ where: { id, businessId } });
    if (!current) throw notFound("El cupón no existe.");
    // Validar reglas con el estado final (el PATCH puede mandar solo una parte).
    const type = input.discountType ?? current.discountType;
    const value = input.discountValue ?? toNumber(current.discountValue);
    if (type === "percent" && value > 100) {
      throw new ApiError("VALIDATION_ERROR", "El porcentaje no puede superar 100.");
    }
    const startsAt = input.startsAt === undefined ? current.startsAt : input.startsAt;
    const endsAt = input.endsAt === undefined ? current.endsAt : input.endsAt;
    if (startsAt && endsAt && endsAt < startsAt) {
      throw new ApiError("VALIDATION_ERROR", "La fecha de fin tiene que ser posterior al inicio.");
    }
    await tx.coupon.updateMany({ where: { id, businessId }, data: input });
    return tx.coupon.findUniqueOrThrow({ where: { id } });
  }).catch(duplicate);
  return toCouponDto(row);
}

export async function remove({ ctx, businessId }: BusinessScope, id: string) {
  // Los pedidos que lo usaron conservan coupon_code (coupon_id queda en null).
  const { count } = await withDb(ctx, (tx) => tx.coupon.deleteMany({ where: { id, businessId } }));
  if (count === 0) throw notFound("El cupón no existe.");
}
