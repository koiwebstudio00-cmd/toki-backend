// Categorías. docs/api.md §7.1.
import type { Prisma } from "@prisma/client";
import { withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { deleteReplacedImage, isAllowedImageUrl } from "../../lib/r2.js";
import type { BusinessScope } from "../../lib/request.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "./schemas.js";

type CategoryRow = Prisma.CategoryGetPayload<object>;

export function toCategoryDto(c: CategoryRow, counts?: { products: number; availableProducts: number }) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    imageUrl: c.imageUrl,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
    ...(counts ?? {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  };
}

function assertImage(url: string | null | undefined, businessId: string) {
  if (!isAllowedImageUrl(url, businessId)) {
    throw new ApiError("VALIDATION_ERROR", "La imagen no es válida. Subila de nuevo.", [
      { field: "imageUrl", message: "Usá una imagen subida desde Toki." }
    ]);
  }
}

export async function list({ ctx, businessId }: BusinessScope, active?: boolean) {
  return withDb(ctx, async (tx) => {
    const [rows, counts, available] = await Promise.all([
      tx.category.findMany({
        where: { businessId, ...(active === undefined ? {} : { isActive: active }) },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
      }),
      tx.product.groupBy({ by: ["categoryId"], where: { businessId }, _count: { _all: true } }),
      tx.product.groupBy({ by: ["categoryId"], where: { businessId, isAvailable: true }, _count: { _all: true } })
    ]);
    const total = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    const avail = new Map(available.map((c) => [c.categoryId, c._count._all]));
    return rows.map((c) => toCategoryDto(c, { products: total.get(c.id) ?? 0, availableProducts: avail.get(c.id) ?? 0 }));
  });
}

export async function create({ ctx, businessId }: BusinessScope, input: CreateCategoryInput) {
  assertImage(input.imageUrl, businessId);
  const row = await withDb(ctx, async (tx) => {
    const sortOrder = input.sortOrder ?? (await tx.category.count({ where: { businessId } })) + 1;
    return tx.category.create({ data: { businessId, ...input, description: input.description ?? "", sortOrder } });
  });
  return toCategoryDto(row);
}

export async function update({ ctx, businessId }: BusinessScope, id: string, input: UpdateCategoryInput) {
  assertImage(input.imageUrl, businessId);
  const { previous, row } = await withDb(ctx, async (tx) => {
    const prev = await tx.category.findFirst({ where: { id, businessId }, select: { imageUrl: true } });
    if (!prev) throw notFound("La categoría no existe.");
    const data = { ...input, ...(input.description === null ? { description: "" } : {}) };
    await tx.category.updateMany({ where: { id, businessId }, data });
    return { previous: prev, row: await tx.category.findUniqueOrThrow({ where: { id } }) };
  });
  if (input.imageUrl !== undefined) await deleteReplacedImage(previous.imageUrl, row.imageUrl);
  return toCategoryDto(row);
}

/** Orden final completo: `ids[0]` queda primera. Categorías no listadas van al final. */
export async function reorder({ ctx, businessId }: BusinessScope, ids: string[]) {
  return withDb(ctx, async (tx) => {
    const existing = await tx.category.findMany({ where: { businessId }, select: { id: true }, orderBy: { sortOrder: "asc" } });
    const known = new Set(existing.map((c) => c.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new ApiError("VALIDATION_ERROR", "Hay categorías que no son de tu negocio.");
    const rest = existing.map((c) => c.id).filter((id) => !ids.includes(id));
    const ordered = [...ids, ...rest];
    for (const [index, id] of ordered.entries()) {
      await tx.category.updateMany({ where: { id, businessId }, data: { sortOrder: index + 1 } });
    }
    const rows = await tx.category.findMany({ where: { businessId }, orderBy: { sortOrder: "asc" } });
    return rows.map((c) => toCategoryDto(c));
  });
}

/** Los productos de la categoría quedan sin categoría (FK on delete set null). */
export async function remove({ ctx, businessId }: BusinessScope, id: string) {
  const imageUrl = await withDb(ctx, async (tx) => {
    const prev = await tx.category.findFirst({ where: { id, businessId }, select: { imageUrl: true } });
    if (!prev) throw notFound("La categoría no existe.");
    await tx.category.deleteMany({ where: { id, businessId } });
    return prev.imageUrl;
  });
  await deleteReplacedImage(imageUrl, null);
}
