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

export const orderCodeParam = z.object({
  orderCode: z.string().trim().min(3).max(20)
});

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

export const draftAddItemSchema = z.object({
  businessId,
  conversationId,
  productId: uuid("El producto no existe."),
  quantity: z.coerce.number().int().min(1).max(50).default(1),
  optionValueIds: z.array(uuid()).max(30).default([]),
  notes: z.string().trim().max(300).nullable().optional()
});

export const draftDetailsSchema = z.object({
  businessId,
  conversationId,
  customerName: z.string().trim().max(120).nullable().optional(),
  orderType: z.enum(["delivery", "takeaway"]).nullable().optional(),
  deliveryAddress: z.string().trim().max(300).nullable().optional(),
  paymentMethod: z.enum(["cash", "transfer"]).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

export const confirmDraftSchema = z.object({ businessId, conversationId });

export const orderDetailsSchema = z.object({
  businessId,
  conversationId,
  orderType: z.enum(["delivery", "takeaway"]).nullable().optional(),
  deliveryAddress: z.string().trim().max(300).nullable().optional(),
  paymentMethod: z.enum(["cash", "transfer"]).nullable().optional()
});

export const addDraftItemsSchema = z.object({ businessId, conversationId });

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
export type DraftDetailsInput = z.infer<typeof draftDetailsSchema>;
export type OrderDetailsInput = z.infer<typeof orderDetailsSchema>;
export type PaymentProofInput = z.infer<typeof paymentProofSchema>;
