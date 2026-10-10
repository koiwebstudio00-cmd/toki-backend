import { createHash } from "node:crypto";
import { ApiError } from "../../lib/errors.js";
export interface QuoteOptions { quoteOnly?: boolean; expectedQuote?: string }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  return value;
}
export function quoteHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function checkQuote(quote: unknown, options: QuoteOptions) {
  if (options.expectedQuote && quoteHash(quote) !== options.expectedQuote) {
    throw new ApiError("VALIDATION_ERROR", "El pedido o sus importes cambiaron. Necesito mostrarte un resumen actualizado para que lo confirmes.");
  }
}
