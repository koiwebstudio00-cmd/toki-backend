import { Router } from "express";
import { requireApiKey } from "../../middleware/apiKey.js";
import {
  addDraftItemsSchema,
  businessQuery,
  confirmDraftSchema,
  contextQuery,
  conversationQuery,
  draftAddItemSchema,
  draftDetailsSchema,
  handoffSchema,
  idParam,
  itemIdParam,
  logMessageSchema,
  orderCodeParam,
  orderDetailsSchema,
  orderStatusQuery,
  paymentProofSchema,
  searchQuery,
  upsertConversationSchema
} from "./schemas.js";
import * as svc from "./service.js";

/** /v1/agent — n8n, autenticado con X-Api-Key. */
export const agentRoutes = Router();

agentRoutes.use(requireApiKey);

agentRoutes.get("/integrations/by-account/:accountId", async (req, res) => {
  res.json(await svc.resolveIntegration(String(req.params.accountId)));
});

agentRoutes.post("/conversations/upsert", async (req, res) => {
  res.json(await svc.upsertConversation(upsertConversationSchema.parse(req.body)));
});

agentRoutes.post("/messages", async (req, res) => {
  res.json(await svc.logMessage(logMessageSchema.parse(req.body)));
});

agentRoutes.get("/conversations/:id/context", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { businessId, k } = contextQuery.parse(req.query);
  res.json(await svc.context(businessId, id, k));
});

agentRoutes.post("/conversations/:id/handoff", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { businessId, reason } = handoffSchema.parse(req.body);
  res.json(await svc.handoff(businessId, id, reason));
});

// Catálogo
agentRoutes.get("/products/search", async (req, res) => {
  const { businessId, q, limit } = searchQuery.parse(req.query);
  res.json(await svc.searchProducts(businessId, q, limit));
});

agentRoutes.get("/products/:id", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { businessId } = businessQuery.parse(req.query);
  res.json(await svc.productDetail(businessId, id));
});

agentRoutes.get("/faq/search", async (req, res) => {
  const { businessId, q, limit } = searchQuery.parse(req.query);
  res.json(await svc.searchFaq(businessId, q, limit));
});

// Borrador. `/draft/...` va antes que `/orders/:orderCode` por claridad de lectura;
// no comparten prefijo, así que no hay ambigüedad de ruteo.
agentRoutes.get("/draft", async (req, res) => {
  const { businessId, conversationId } = conversationQuery.parse(req.query);
  res.json(await svc.draftGet(businessId, conversationId));
});

agentRoutes.post("/draft/items", async (req, res) => {
  res.json(await svc.draftAddItem(draftAddItemSchema.parse(req.body)));
});

agentRoutes.delete("/draft/items/:itemId", async (req, res) => {
  const { itemId } = itemIdParam.parse(req.params);
  const { businessId, conversationId } = conversationQuery.parse(req.query);
  res.json(await svc.draftRemoveItem(businessId, conversationId, itemId));
});

agentRoutes.patch("/draft", async (req, res) => {
  res.json(await svc.draftSetDetails(draftDetailsSchema.parse(req.body)));
});

agentRoutes.delete("/draft", async (req, res) => {
  const { businessId, conversationId } = conversationQuery.parse(req.query);
  res.json(await svc.draftCancel(businessId, conversationId));
});

agentRoutes.post("/draft/confirm", async (req, res) => {
  const { businessId, conversationId } = confirmDraftSchema.parse(req.body);
  const result = await svc.confirmDraft(businessId, conversationId);
  // 201 solo cuando el pedido se creó recién. Un reintento (`yaExistia`) y los
  // errores del cliente final van con 200: el request de n8n está bien, lo que
  // falla es el pedido, y el agente lo lee en `ok`.
  const creado = result.ok && !("yaExistia" in result);
  res.status(creado ? 201 : 200).json(result);
});

// Pedido ya confirmado
agentRoutes.get("/orders/status", async (req, res) => {
  const { businessId, conversationId, orderCode } = orderStatusQuery.parse(req.query);
  res.json(await svc.orderStatus(businessId, conversationId, orderCode));
});

agentRoutes.patch("/orders/:orderCode", async (req, res) => {
  const { orderCode } = orderCodeParam.parse(req.params);
  res.json(await svc.updateOrderDetails(orderDetailsSchema.parse(req.body), orderCode));
});

agentRoutes.post("/orders/:orderCode/items", async (req, res) => {
  const { orderCode } = orderCodeParam.parse(req.params);
  const { businessId, conversationId } = addDraftItemsSchema.parse(req.body);
  res.json(await svc.addDraftItemsToOrder(businessId, conversationId, orderCode));
});

agentRoutes.post("/payment-proofs", async (req, res) => {
  res.json(await svc.savePaymentProof(paymentProofSchema.parse(req.body)));
});
