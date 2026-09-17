// Productos con grupos de opciones y valores. docs/api.md §7.2.
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { type Tx, withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import { deleteReplacedImage, isAllowedImageUrl } from "../../lib/r2.js";
import type { BusinessScope } from "../../lib/request.js";
import { mapDbError } from "../../middleware/error.js";
import type { ListProductsQuery, ProductInput } from "./schemas.js";

const productInclude = {
  category: { select: { id: true, name: true, isActive: true } },
  options: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { values: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } }
  }
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export function toProductDto(p: ProductRow) {
  return {
    id: p.id,
    categoryId: p.categoryId,
    category: p.category,
    name: p.name,
    description: p.description,
    price: toNumber(p.price),
    imageUrl: p.imageUrl,
    isAvailable: p.isAvailable,
    isFeatured: p.isFeatured,
    preparationMinutes: p.preparationMinutes,
    sortOrder: p.sortOrder,
    barcode: p.barcode,
    trackStock: p.trackStock,
    stockQuantity: p.stockQuantity,
    lowStockThreshold: p.lowStockThreshold,
    isLowStock: p.trackStock && p.stockQuantity <= p.lowStockThreshold,
    options: p.options.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type as "single" | "multiple",
      isRequired: o.isRequired,
      minSelect: o.minSelect,
      maxSelect: o.maxSelect,
      sortOrder: o.sortOrder,
      values: o.values.map((v) => ({
        id: v.id,
        name: v.name,
        priceDelta: toNumber(v.priceDelta),
        isAvailable: v.isAvailable,
        sortOrder: v.sortOrder,
        trackStock: v.trackStock,
        stockQuantity: v.stockQuantity,
        lowStockThreshold: v.lowStockThreshold
      }))
    })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  };
}

function conflictOrRethrow(err: unknown): never {
  if (mapDbError(err)?.code === "CONFLICT") {
    throw new ApiError("CONFLICT", "Ya tenés otro producto con ese código de barras.");
  }
  throw err;
}

/** Mismo formato que el default de la BD (TKI- + 10 hex) sin depender de un round-trip. */
function newBarcode(): string {
  return `TKI-${randomBytes(5).toString("hex").toUpperCase()}`;
}

export async function list({ ctx, businessId }: BusinessScope, q: ListProductsQuery) {
  const where: Prisma.ProductWhereInput = {
    businessId,
    ...(q.categoryId ? { categoryId: q.categoryId } : {}),
    ...(q.available === undefined ? {} : { isAvailable: q.available }),
    ...(q.featured === undefined ? {} : { isFeatured: q.featured }),
    ...(q.barcode ? { barcode: q.barcode } : {}),
    ...(q.search
      ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { barcode: { equals: q.search, mode: "insensitive" } }] }
      : {})
  };
  const rows = await withDb(ctx, (tx) =>
    tx.product.findMany({ where, include: productInclude, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
  );
  const dtos = rows.map(toProductDto);
  // Comparación entre columnas: más simple en memoria (catálogos de cientos de productos).
  return q.lowStock ? dtos.filter((p) => p.isLowStock) : dtos;
}

export async function get({ ctx, businessId }: BusinessScope, id: string) {
  const row = await withDb(ctx, (tx) => tx.product.findFirst({ where: { id, businessId }, include: productInclude }));
  if (!row) throw notFound("El producto no existe.");
  return toProductDto(row);
}

async function resolveCategory(tx: Tx, businessId: string, input: ProductInput): Promise<string | null> {
  if (input.newCategoryName) {
    const count = await tx.category.count({ where: { businessId } });
    const cat = await tx.category.create({
      data: { businessId, name: input.newCategoryName, description: "", sortOrder: count + 1 },
      select: { id: true }
    });
    return cat.id;
  }
  if (!input.categoryId) return null;
  const cat = await tx.category.findFirst({ where: { id: input.categoryId, businessId }, select: { id: true } });
  if (!cat) throw new ApiError("VALIDATION_ERROR", "La categoría no existe.", [{ field: "categoryId", message: "Elegí una categoría de tu negocio." }]);
  return cat.id;
}

function productData(input: ProductInput) {
  return {
    name: input.name,
    description: input.description ?? null,
    price: input.price,
    imageUrl: input.imageUrl ?? null,
    isAvailable: input.isAvailable,
    isFeatured: input.isFeatured,
    preparationMinutes: input.preparationMinutes ?? null,
    trackStock: input.trackStock,
    stockQuantity: input.stockQuantity,
    lowStockThreshold: input.lowStockThreshold
  };
}

/**
 * Sincroniza los grupos de opciones conservando los ids que el cliente manda:
 * actualiza los existentes, crea los nuevos y borra los que ya no vienen. Así los
 * borradores de WhatsApp que referencian valores (option_value_ids) no se rompen
 * cada vez que se edita el producto.
 */
async function syncOptions(tx: Tx, businessId: string, productId: string, options: ProductInput["options"]) {
  const existing = await tx.productOption.findMany({
    where: { productId, businessId },
    select: { id: true, values: { select: { id: true } } }
  });
  const existingIds = new Map(existing.map((o) => [o.id, new Set(o.values.map((v) => v.id))]));
  const keptOptionIds = new Set<string>();

  for (const [optionIndex, option] of options.entries()) {
    const optionData = {
      name: option.name,
      type: option.type,
      isRequired: option.isRequired,
      minSelect: option.minSelect,
      maxSelect: option.maxSelect,
      sortOrder: optionIndex + 1
    };

    let optionId: string;
    const existingValues = option.id ? existingIds.get(option.id) : undefined;
    if (option.id && existingValues) {
      optionId = option.id;
      await tx.productOption.updateMany({ where: { id: optionId, businessId }, data: optionData });
    } else {
      const created = await tx.productOption.create({ data: { businessId, productId, ...optionData }, select: { id: true } });
      optionId = created.id;
    }
    keptOptionIds.add(optionId);

    const keptValueIds = new Set<string>();
    for (const [valueIndex, value] of option.values.entries()) {
      const valueData = {
        name: value.name,
        priceDelta: value.priceDelta,
        isAvailable: value.isAvailable,
        trackStock: value.trackStock,
        stockQuantity: value.stockQuantity,
        lowStockThreshold: value.lowStockThreshold,
        sortOrder: valueIndex + 1
      };
      if (value.id && existingValues?.has(value.id)) {
        await tx.productOptionValue.updateMany({ where: { id: value.id, businessId }, data: valueData });
        keptValueIds.add(value.id);
      } else {
        const created = await tx.productOptionValue.create({ data: { businessId, optionId, ...valueData }, select: { id: true } });
        keptValueIds.add(created.id);
      }
    }
    await tx.productOptionValue.deleteMany({ where: { optionId, businessId, id: { notIn: [...keptValueIds] } } });
  }

  await tx.productOption.deleteMany({ where: { productId, businessId, id: { notIn: [...keptOptionIds] } } });
}

function assertImage(url: string | null | undefined, businessId: string) {
  if (!isAllowedImageUrl(url, businessId)) {
    throw new ApiError("VALIDATION_ERROR", "La imagen no es válida. Subila de nuevo.", [
      { field: "imageUrl", message: "Usá una imagen subida desde Toki." }
    ]);
  }
}

/** Alta completa en UNA transacción (hoy el front hace 3 escrituras sueltas). */
export async function create({ ctx, businessId }: BusinessScope, input: ProductInput) {
  assertImage(input.imageUrl, businessId);
  const row = await withDb(ctx, async (tx) => {
    const categoryId = await resolveCategory(tx, businessId, input);
    const sortOrder = input.sortOrder ?? (await tx.product.count({ where: { businessId } })) + 1;
    const product = await tx.product.create({
      data: { businessId, categoryId, sortOrder, barcode: input.barcode ?? newBarcode(), ...productData(input) },
      select: { id: true }
    });
    await syncOptions(tx, businessId, product.id, input.options);
    return tx.product.findUniqueOrThrow({ where: { id: product.id }, include: productInclude });
  }).catch(conflictOrRethrow);
  return toProductDto(row);
}

/** Reemplazo completo (PUT): datos, categoría y opciones. */
export async function replace({ ctx, businessId }: BusinessScope, id: string, input: ProductInput) {
  assertImage(input.imageUrl, businessId);
  const { previousImage, row } = await withDb(ctx, async (tx) => {
    const current = await tx.product.findFirst({ where: { id, businessId }, select: { imageUrl: true, barcode: true, sortOrder: true } });
    if (!current) throw notFound("El producto no existe.");
    const categoryId = await resolveCategory(tx, businessId, input);
    await tx.product.updateMany({
      where: { id, businessId },
      data: {
        categoryId,
        sortOrder: input.sortOrder ?? current.sortOrder,
        barcode: input.barcode ?? current.barcode,
        ...productData(input)
      }
    });
    await syncOptions(tx, businessId, id, input.options);
    return { previousImage: current.imageUrl, row: await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude }) };
  }).catch(conflictOrRethrow);
  await deleteReplacedImage(previousImage, row.imageUrl);
  return toProductDto(row);
}

export async function setAvailability({ ctx, businessId }: BusinessScope, id: string, isAvailable: boolean) {
  return patchProduct(ctx, businessId, id, { isAvailable });
}

export async function setStock({ ctx, businessId }: BusinessScope, id: string, stockQuantity: number, trackStock?: boolean) {
  return patchProduct(ctx, businessId, id, { stockQuantity, ...(trackStock === undefined ? {} : { trackStock }) });
}

async function patchProduct(ctx: BusinessScope["ctx"], businessId: string, id: string, data: Prisma.ProductUpdateManyMutationInput) {
  const row = await withDb(ctx, async (tx) => {
    const { count } = await tx.product.updateMany({ where: { id, businessId }, data });
    if (count === 0) throw notFound("El producto no existe.");
    return tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });
  });
  return toProductDto(row);
}

/** Los pedidos conservan el snapshot (order_items.product_id queda en null). */
export async function remove({ ctx, businessId }: BusinessScope, id: string) {
  const imageUrl = await withDb(ctx, async (tx) => {
    const current = await tx.product.findFirst({ where: { id, businessId }, select: { imageUrl: true } });
    if (!current) throw notFound("El producto no existe.");
    await tx.product.deleteMany({ where: { id, businessId } });
    return current.imageUrl;
  });
  await deleteReplacedImage(imageUrl, null);
}
