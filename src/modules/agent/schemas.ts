// docs/api.md §14. El agente (n8n) manda siempre businessId y conversationId;
// las funciones SQL validan que la conversación sea de ese negocio.
import { z } from "zod";
import { uuid } from "../../lib/validation.js";

const businessId = uuid("businessId inválido.");
const conversationId = uuid("conversationId inválido.");

export const businessQuery = z.object({ businessId });

export const conversationQuery = z.object({ businessId, conversationId });

export const idParam = z.object({ id: uuid() });

export const itemIdParam = z.object({ itemId: uuid() });

/**
 * Producto o valor de opción: el UUID completo o el id corto de la carta del
 * contexto (6 u 8 caracteres). El service lo resuelve dentro del negocio.
 */
const catalogRef = (message: string) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f][0-9a-f-]{3,35}$/, message);

export const productRefParam = z.object({ id: catalogRef("El producto no existe.") });

export const upsertConversationSchema = z.object({
  businessId,
  contactId: z.string().trim().min(1, "Falta el contacto.").max(160),
  phone: z.string().trim().max(40).nullable().optional()
});

export const logMessageSchema = z.object({
  businessId,
  conversationId,
  direction: z.enum(["inbound", "outbound"]),
  messageType: z.string().trim().min(1).max(40).default("text"),
  content: z.string().max(8000).nullable().optional(),
  providerMessageId: z.string().trim().max(200).nullable().optional(),
  rawPayload: z.unknown().optional(),
  aiIntent: z.string().trim().max(80).nullable().optional()
});

export const messagesQuery = z.object({
  businessId,
  after: z.string().datetime({ message: "Fecha inválida." }).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const contextQuery = z.object({
  businessId,
  k: z.coerce.number().int().min(1).max(50).default(20)
});

export const searchQuery = z.object({
  businessId,
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(6)
});

export const orderStatusQuery = z.object({
  businessId,
  conversationId,
  orderCode: z.string().trim().max(20).optional()
});

const draftItem = z.object({
  productId: catalogRef("El producto no existe."),
  quantity: z.coerce.number().int().min(1).max(50).default(1),
  optionValueIds: z.array(catalogRef("Alguna de las opciones elegidas no existe.")).max(30).default([]),
  notes: z.string().trim().max(300).nullable().optional()
});

export const draftAddItemSchema = draftItem.extend({ businessId, conversationId });

/**
 * Varios items en una llamada (v3). n8n a veces manda el array del modelo como
 * texto JSON: se acepta las dos formas.
 */
export const draftAddItemsSchema = z.object({
  businessId,
  conversationId,
  items: z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    },
    z.array(draftItem).min(1, "No hay productos para agregar.").max(20)
  )
});

export const draftItemQuantitySchema = z.object({
  businessId,
  conversationId,
  quantity: z.coerce.number().int().min(0).max(50)
});

export const draftDetailsSchema = z.object({
  businessId,
  conversationId,
  customerName: z.string().trim().max(120).nullable().optional(),
  orderType: z.enum(["delivery", "takeaway"]).nullable().optional(),
  deliveryAddress: z.string().trim().max(300).nullable().optional(),
  // `mercadopago` incluido a propósito: la función SQL lo acepta y verifica que
  // el negocio lo tenga habilitado, devolviendo un motivo legible. Recortarlo
  // acá convertía ese caso en un 400 que el agente no sabe explicar.
  paymentMethod: z.enum(["cash", "transfer", "mercadopago"]).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

export const confirmDraftSchema = z.object({ businessId, conversationId });

/** `orderCode` opcional: sin código, la función SQL resuelve el último pedido
 *  editable del contacto, que es lo que el cliente quiere decir casi siempre. */
export const orderDetailsSchema = z.object({
  businessId,
  conversationId,
  orderCode: z.string().trim().max(20).optional(),
  orderType: z.enum(["delivery", "takeaway"]).nullable().optional(),
  deliveryAddress: z.string().trim().max(300).nullable().optional(),
  paymentMethod: z.enum(["cash", "transfer", "mercadopago"]).nullable().optional()
});

export const addDraftItemsSchema = z.object({
  businessId,
  conversationId,
  orderCode: z.string().trim().max(20).optional()
});

export const handoffSchema = z.object({
  businessId,
  reason: z.string().trim().max(120).nullable().optional()
});

export const paymentProofSchema = z.object({
  businessId,
  conversationId,
  mediaUrl: z.string().url("La URL del adjunto no es válida."),
  mediaType: z.string().trim().max(40).default("image"),
  orderCode: z.string().trim().max(20).nullable().optional(),
  providerMessageId: z.string().trim().max(200).nullable().optional()
});

export type UpsertConversationInput = z.infer<typeof upsertConversationSchema>;
export type LogMessageInput = z.infer<typeof logMessageSchema>;
export type DraftAddItemInput = z.infer<typeof draftAddItemSchema>;
export type DraftAddItemsInput = z.infer<typeof draftAddItemsSchema>;
export type DraftDetailsInput = z.infer<typeof draftDetailsSchema>;
export type OrderDetailsInput = z.infer<typeof orderDetailsSchema>;
export type PaymentProofInput = z.infer<typeof paymentProofSchema>;
