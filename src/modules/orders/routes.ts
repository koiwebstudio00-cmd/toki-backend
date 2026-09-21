import { Router } from "express";
import { businessScope } from "../../lib/request.js";
import { idParams } from "../../lib/validation.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusiness } from "../../middleware/business.js";
import { changeStatusSchema, listOrdersQuery, manualSaleSchema, reviewProofSchema } from "./schemas.js";
import * as svc from "./service.js";
import { openEventStream } from "./stream.js";
import { issueTicket } from "../../lib/tickets.js";

/**
 * /v1/orders/events — sin Authorization: EventSource no manda headers, así que
 * la sesión viaja como ticket de un solo uso. Va en su propio router para que
 * no lo toquen requireAuth/requireBusiness, y ANTES que `/orders/:id`.
 */
export const orderStreamRoutes = Router();

orderStreamRoutes.get("/events", (req, res) => {
  openEventStream(typeof req.query.ticket === "string" ? req.query.ticket : undefined, req, res);
});

/** /v1/orders */
export const orderRoutes = Router();

orderRoutes.use(requireAuth, requireBusiness);

orderRoutes.post("/events/ticket", (req, res) => {
  const { businessId } = businessScope(req);
  res.json(issueTicket(businessId, req.auth!.userId));
});

orderRoutes.get("/", async (req, res) => {
  res.json(await svc.list(businessScope(req), listOrdersQuery.parse(req.query)));
});

orderRoutes.post("/manual", async (req, res) => {
  res.status(201).json(await svc.createManualSale(businessScope(req), manualSaleSchema.parse(req.body)));
});

orderRoutes.get("/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.get(businessScope(req), id));
});

orderRoutes.patch("/:id/status", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.changeStatus(businessScope(req), id, changeStatusSchema.parse(req.body)));
});

orderRoutes.post("/:id/mark-paid", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.markPaid(businessScope(req), id));
});

orderRoutes.get("/:id/payment-proofs", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ data: await svc.listPaymentProofs(businessScope(req), id) });
});

/** /v1/payment-proofs */
export const paymentProofRoutes = Router();

paymentProofRoutes.use(requireAuth, requireBusiness);

paymentProofRoutes.patch("/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { status } = reviewProofSchema.parse(req.body);
  res.json(await svc.reviewPaymentProof(businessScope(req), id, status, req.auth!.userId));
});
