import { Router } from "express";
import { publicReadLimiter, publicWriteLimiter } from "../../middleware/rateLimit.js";
import { checkoutSchema, slugCodeParams, slugIdParams, slugParams, validateCouponSchema } from "./schemas.js";
import * as svc from "./service.js";

/** /v1/public — sin sesión. Lo consume el menú del cliente final. */
export const publicRoutes = Router();

publicRoutes.get("/businesses/:slug", publicReadLimiter(), async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  res.json(await svc.getMenu(slug));
});

publicRoutes.get("/businesses/:slug/products/:id", publicReadLimiter(), async (req, res) => {
  const { slug, id } = slugIdParams.parse(req.params);
  res.json(await svc.getProduct(slug, id));
});

publicRoutes.post("/businesses/:slug/coupons/validate", publicWriteLimiter(), async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  res.json(await svc.validatePublicCoupon(slug, validateCouponSchema.parse(req.body)));
});

publicRoutes.post("/businesses/:slug/orders", publicWriteLimiter(), async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  res.status(201).json(await svc.createOrder(slug, checkoutSchema.parse(req.body)));
});

publicRoutes.get("/businesses/:slug/orders/:code", publicReadLimiter(), async (req, res) => {
  const { slug, code } = slugCodeParams.parse(req.params);
  res.json(await svc.trackOrder(slug, code));
});
