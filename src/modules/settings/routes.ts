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
