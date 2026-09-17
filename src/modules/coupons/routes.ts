import { Router } from "express";
import { businessScope } from "../../lib/request.js";
import { idParams } from "../../lib/validation.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireAdmin, requireBusiness } from "../../middleware/business.js";
import { createCouponSchema, updateCouponSchema } from "./schemas.js";
import * as svc from "./service.js";

/** /v1/coupons */
export const couponRoutes = Router();

couponRoutes.use(requireAuth, requireBusiness);

// Solo owner/admin: RLS le muestra a staff únicamente los cupones activos
// (policy pública), así que un listado para staff sería incompleto.
couponRoutes.get("/", requireAdmin, async (req, res) => {
  res.json({ data: await svc.list(businessScope(req)) });
});

couponRoutes.post("/", requireAdmin, async (req, res) => {
  res.status(201).json(await svc.create(businessScope(req), createCouponSchema.parse(req.body)));
});

couponRoutes.patch("/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.update(businessScope(req), id, updateCouponSchema.parse(req.body)));
});

couponRoutes.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  await svc.remove(businessScope(req), id);
  res.status(204).end();
});
