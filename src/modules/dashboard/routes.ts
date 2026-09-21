import { Router } from "express";
import { z } from "zod";
import { businessScope } from "../../lib/request.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusiness } from "../../middleware/business.js";
import * as svc from "./service.js";

const summaryQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const searchQuery = z.object({
  q: z.string().trim().min(2, "Escribí al menos 2 letras para buscar.").max(80)
});

/** /v1/dashboard */
export const dashboardRoutes = Router();

dashboardRoutes.use(requireAuth, requireBusiness);

dashboardRoutes.get("/summary", async (req, res) => {
  const { days } = summaryQuery.parse(req.query);
  res.json(await svc.summary(businessScope(req), days));
});

dashboardRoutes.get("/search", async (req, res) => {
  const { q } = searchQuery.parse(req.query);
  res.json({ data: await svc.search(businessScope(req), q) });
});
