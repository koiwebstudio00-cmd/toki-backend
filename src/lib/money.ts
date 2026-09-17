import { Prisma } from "@prisma/client";

// Prisma devuelve numeric como Decimal y res.json() no los serializa como número.
// Los montos salen de los repos ya convertidos (gotcha de back-lamelas).

type Numeric = Prisma.Decimal | number | string | bigint;

export function toNumber(value: Numeric): number;
export function toNumber(value: Numeric | null | undefined): number | null;
export function toNumber(value: Numeric | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value.toString());
}
