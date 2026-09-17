// Stock de insumos. docs/api.md §7.3.
import type { Prisma } from "@prisma/client";
import { withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import type { BusinessScope } from "../../lib/request.js";
import { mapDbError } from "../../middleware/error.js";
import type { CreateIngredientInput, UpdateIngredientInput } from "./schemas.js";

type IngredientRow = Prisma.InventoryIngredientGetPayload<object>;

function toDto(i: IngredientRow) {
  const quantity = toNumber(i.quantity);
  const lowStockThreshold = toNumber(i.lowStockThreshold);
  return {
    id: i.id,
    name: i.name,
    quantity,
    unit: i.unit as "kg" | "g" | "l" | "ml" | "unit",
    lowStockThreshold,
    isLowStock: quantity <= lowStockThreshold,
    notes: i.notes,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt
  };
}

const duplicate = (err: unknown): never => {
  if (mapDbError(err)?.code === "CONFLICT") throw new ApiError("CONFLICT", "Ya tenés un ingrediente con ese nombre.");
  throw err;
};

export async function list({ ctx, businessId }: BusinessScope, lowStock?: boolean) {
  const rows = await withDb(ctx, (tx) => tx.inventoryIngredient.findMany({ where: { businessId }, orderBy: { name: "asc" } }));
  const dtos = rows.map(toDto);
  return lowStock ? dtos.filter((i) => i.isLowStock) : dtos;
}

export async function create({ ctx, businessId }: BusinessScope, input: CreateIngredientInput) {
  const row = await withDb(ctx, (tx) => tx.inventoryIngredient.create({ data: { businessId, ...input } })).catch(duplicate);
  return toDto(row);
}

export async function update({ ctx, businessId }: BusinessScope, id: string, input: UpdateIngredientInput) {
  const row = await withDb(ctx, async (tx) => {
    const { count } = await tx.inventoryIngredient.updateMany({ where: { id, businessId }, data: input });
    if (count === 0) throw notFound("El ingrediente no existe.");
    return tx.inventoryIngredient.findUniqueOrThrow({ where: { id } });
  }).catch(duplicate);
  return toDto(row);
}

export async function remove({ ctx, businessId }: BusinessScope, id: string) {
  const { count } = await withDb(ctx, (tx) => tx.inventoryIngredient.deleteMany({ where: { id, businessId } }));
  if (count === 0) throw notFound("El ingrediente no existe.");
}
