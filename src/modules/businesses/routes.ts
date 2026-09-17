import { Router } from "express";
import { businessScope, userCtx } from "../../lib/request.js";
import { idParams } from "../../lib/validation.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireAdmin, requireBusiness } from "../../middleware/business.js";
import {
  createBusinessSchema,
  hoursSchema,
  specialHoursQuery,
  specialHoursSchema,
  statusSchema,
  updateBusinessSchema
} from "./schemas.js";
import * as svc from "./service.js";

/** POST /v1/businesses — onboarding (solo requiere sesión). */
export const onboardingRoutes = Router();

onboardingRoutes.post("/", requireAuth, async (req, res) => {
  res.status(201).json(await svc.createWithOwner(userCtx(req), createBusinessSchema.parse(req.body)));
});

/** /v1/business — negocio actual. */
export const businessRoutes = Router();

businessRoutes.use(requireAuth, requireBusiness);

businessRoutes.get("/", async (req, res) => {
  res.json(await svc.getCurrent(businessScope(req)));
});

businessRoutes.patch("/", requireAdmin, async (req, res) => {
  res.json(await svc.update(businessScope(req), updateBusinessSchema.parse(req.body)));
});

businessRoutes.patch("/status", requireAdmin, async (req, res) => {
  const { manualStatus } = statusSchema.parse(req.body);
  res.json(await svc.setManualStatus(businessScope(req), manualStatus));
});

businessRoutes.get("/hours", async (req, res) => {
  res.json({ data: await svc.getHours(businessScope(req)) });
});

businessRoutes.put("/hours", requireAdmin, async (req, res) => {
  const { hours } = hoursSchema.parse(req.body);
  res.json({ data: await svc.replaceHours(businessScope(req), hours) });
});

businessRoutes.get("/special-hours", async (req, res) => {
  const { from } = specialHoursQuery.parse(req.query);
  res.json({ data: await svc.listSpecialHours(businessScope(req), from) });
});

businessRoutes.put("/special-hours", requireAdmin, async (req, res) => {
  const { specialHours } = specialHoursSchema.parse(req.body);
  res.json({ data: await svc.replaceSpecialHours(businessScope(req), specialHours) });
});

businessRoutes.delete("/special-hours/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  await svc.deleteSpecialHour(businessScope(req), id);
  res.status(204).end();
});

businessRoutes.get("/checklist", async (req, res) => {
  res.json(await svc.getChecklist(businessScope(req)));
});
