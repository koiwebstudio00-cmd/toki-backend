import { Router } from "express";
import { businessScope } from "../../lib/request.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireAdmin, requireBusiness } from "../../middleware/business.js";
import {
  completeConnectSchema,
  conversationParams,
  conversationStatusSchema,
  listConversationsQuery,
  listMessagesQuery,
  startConnectSchema
} from "./schemas.js";
import * as svc from "./service.js";

/** /v1/whatsapp — conexión de la cuenta. Solo owner y admin (igual que la policy). */
export const whatsappRoutes = Router();

whatsappRoutes.use(requireAuth, requireBusiness, requireAdmin);

whatsappRoutes.get("/integration", async (req, res) => {
  res.json(await svc.getIntegration(businessScope(req)));
});

whatsappRoutes.post("/connect/start", async (req, res) => {
  res.json(await svc.startConnect(businessScope(req), startConnectSchema.parse(req.body)));
});

whatsappRoutes.post("/connect/complete", async (req, res) => {
  res.json(await svc.completeConnect(businessScope(req), completeConnectSchema.parse(req.body)));
});

/** /v1/conversations — inbox. Lo usa todo el equipo, staff incluido. */
export const conversationRoutes = Router();

conversationRoutes.use(requireAuth, requireBusiness);

conversationRoutes.get("/", async (req, res) => {
  res.json(await svc.listConversations(businessScope(req), listConversationsQuery.parse(req.query)));
});

conversationRoutes.get("/:id/messages", async (req, res) => {
  const { id } = conversationParams.parse(req.params);
  res.json(await svc.listMessages(businessScope(req), id, listMessagesQuery.parse(req.query)));
});

conversationRoutes.patch("/:id/status", async (req, res) => {
  const { id } = conversationParams.parse(req.params);
  const { status } = conversationStatusSchema.parse(req.body);
  res.json(await svc.setConversationStatus(businessScope(req), id, status));
});
