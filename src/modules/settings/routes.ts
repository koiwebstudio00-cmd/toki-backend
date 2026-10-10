import { channelConfigSchema, channelStatus, configureChannel, reviewSchema, reviewTurn } from "../agent/channel-admin.js";
import { Router } from "express";
import { businessScope } from "../../lib/request.js";
import { idParams } from "../../lib/validation.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireAdmin, requireBusiness } from "../../middleware/business.js";
import {
  botSettingsSchema,
  createFaqSchema,
  loyaltySettingsSchema,
  paymentSettingsSchema,
  updateFaqSchema
} from "./schemas.js";
import * as svc from "./service.js";
import { AGENT_CAPABILITIES } from "../agent/configuration.js";
import { limitPerMinute } from "../../middleware/rateLimit.js";
import { previewMessage } from "../agent/preview.js";
import { MAX_PREVIEW_TURNS, previewInput } from "../agent/preview-memory.js";
import { modelConfigured } from "../agent/runtime.js";

/** /v1/settings */
export const settingsRoutes = Router();

settingsRoutes.use(requireAuth, requireBusiness);

settingsRoutes.get("/payments", async (req, res) => {
  res.json(await svc.getPaymentSettings(businessScope(req)));
});

settingsRoutes.put("/payments", requireAdmin, async (req, res) => {
  res.json(await svc.upsertPaymentSettings(businessScope(req), paymentSettingsSchema.parse(req.body)));
});

settingsRoutes.get("/loyalty", async (req, res) => {
  res.json(await svc.getLoyalty(businessScope(req)));
});

settingsRoutes.put("/loyalty", requireAdmin, async (req, res) => {
  res.json(await svc.upsertLoyalty(businessScope(req), loyaltySettingsSchema.parse(req.body)));
});

settingsRoutes.get("/bot", async (req, res) => {
  res.json(await svc.getBotSettings(businessScope(req)));
});

settingsRoutes.get("/bot/capabilities", (_req, res) => {
  res.json({ data: AGENT_CAPABILITIES });
});

settingsRoutes.get("/bot/preview", requireAdmin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ available: modelConfigured(), maxTurns: MAX_PREVIEW_TURNS, mode: "read_only" });
});

settingsRoutes.post("/bot/preview/messages", requireAdmin, limitPerMinute(6), async (req, res) => {
  const input = previewInput.parse(req.body);
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", onClose);
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await previewMessage(businessScope(req), input, controller.signal));
  } finally {
    res.off("close", onClose);
  }
});

settingsRoutes.patch("/bot", requireAdmin, async (req, res) => {
  res.json(await svc.updateBotSettings(businessScope(req), botSettingsSchema.parse(req.body)));
});

settingsRoutes.get("/bot/faqs", async (req, res) => {
  res.json({ data: await svc.listFaqs(businessScope(req)) });
});

settingsRoutes.post("/bot/faqs", requireAdmin, async (req, res) => {
  res.status(201).json(await svc.createFaq(businessScope(req), createFaqSchema.parse(req.body)));
});

settingsRoutes.patch("/bot/faqs/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.updateFaq(businessScope(req), id, updateFaqSchema.parse(req.body)));
});

settingsRoutes.delete("/bot/faqs/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  await svc.deleteFaq(businessScope(req), id);
  res.status(204).end();
});

settingsRoutes.get("/bot/channel", requireAdmin, async (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json(await channelStatus(businessScope(req))); });
settingsRoutes.patch("/bot/channel", requireAdmin, async (req, res) => { res.json(await configureChannel(businessScope(req), channelConfigSchema.parse(req.body))); });
settingsRoutes.post("/bot/channel/turns/:id/review", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await reviewTurn(businessScope(req), id, reviewSchema.parse(req.body)));
});
