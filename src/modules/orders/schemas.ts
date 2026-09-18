// docs/api.md §9.
import { z } from "zod";
import { isoDate, money, uuid } from "../../lib/validation.js";

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "out_for_delivery",
  "delivered",
  "cancelled"
] as const;

export const listOrdersQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  source: z.enum(["web", "whatsapp", "manual"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const changeStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, { errorMap: () => ({ message: "Ese estado no existe." }) }),
  note: z.string().trim().max(300, "La nota es demasiado larga.").nullable().optional()
});

const manualSaleItemSchema = z.object({
  productId: uuid("Elegí un producto de tu catálogo."),
  quantity: z.coerce
    .number({ invalid_type_error: "Revisá las cantidades." })
    .int("Revisá las cantidades.")
    .min(1, "La cantidad mínima es 1.")
    .max(500, "Esa cantidad es demasiado alta."),
  notes: z.string().trim().max(300, "La aclaración es demasiado larga.").nullable().optional(),
  // Solo ids: los nombres y los recargos salen de la base, nunca del cliente.
  options: z
    .array(
      z.object({
        optionId: uuid("Esa opción no existe."),
        valueIds: z.array(uuid("Esa opción no existe.")).max(20)
      })
    )
    .max(20)
    .default([])
});

export const manualSaleSchema = z.object({
  customerName: z.string().trim().max(120, "El nombre es demasiado largo.").nullable().optional(),
  customerPhone: z.string().trim().max(30, "Revisá el teléfono.").nullable().optional(),
  paymentMethod: z.enum(["cash", "transfer"], {
    errorMap: () => ({ message: "En el mostrador solo se puede cobrar en efectivo o por transferencia." })
  }),
  discountTotal: money("El descuento").default(0),
  notes: z.string().trim().max(500, "La aclaración es demasiado larga.").nullable().optional(),
  items: z.array(manualSaleItemSchema).min(1, "Agregá al menos un producto.").max(100)
});

export const reviewProofSchema = z.object({
  status: z.enum(["approved", "rejected"], { errorMap: () => ({ message: "Elegí aprobar o rechazar." }) })
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuery>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
export type ManualSaleInput = z.infer<typeof manualSaleSchema>;
export type ReviewProofInput = z.infer<typeof reviewProofSchema>;
