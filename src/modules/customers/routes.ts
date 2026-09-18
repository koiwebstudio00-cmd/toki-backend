import { Router } from "express";
import { businessScope } from "../../lib/request.js";
import { idParams } from "../../lib/validation.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusiness } from "../../middleware/business.js";
import { listCustomersQuery } from "./schemas.js";
import * as svc from "./service.js";

/** /v1/customers */
export const customerRoutes = Router();

customerRoutes.use(requireAuth, requireBusiness);

customerRoutes.get("/", async (req, res) => {
  res.json(await svc.list(businessScope(req), listCustomersQuery.parse(req.query)));
});

customerRoutes.get("/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.get(businessScope(req), id));
});
