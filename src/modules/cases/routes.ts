import { Router } from "express";
import { businessScope } from "../../lib/request.js";
import { idParams } from "../../lib/validation.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireAdmin, requireBusiness } from "../../middleware/business.js";
import {
  completeRefundSchema,
  listRefundsQuery,
  refundProofUploadSchema,
  rejectRefundSchema,
  resolveCaseSchema
} from "./schemas.js";
import * as svc from "./service.js";

/** /v1/cases — derivaciones del agente. Las resuelve cualquier miembro del equipo. */
export const caseRoutes = Router();
caseRoutes.use(requireAuth, requireBusiness);

caseRoutes.post("/:id/resolve", async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { note } = resolveCaseSchema.parse(req.body ?? {});
  res.json(await svc.resolveCase(businessScope(req), id, note));
});

/** /v1/refunds — el equipo los ve; devolver o rechazar es de owner y admin (es plata). */
export const refundRoutes = Router();
refundRoutes.use(requireAuth, requireBusiness);

refundRoutes.get("/", async (req, res) => {
  res.json(await svc.listRefunds(businessScope(req), listRefundsQuery.parse(req.query)));
});

refundRoutes.post("/:id/proof-upload", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { contentType } = refundProofUploadSchema.parse(req.body);
  res.json(await svc.refundProofUpload(businessScope(req), id, contentType));
});

refundRoutes.post("/:id/complete", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.completeRefund(businessScope(req), id, completeRefundSchema.parse(req.body ?? {})));
});

refundRoutes.post("/:id/reject", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { notes } = rejectRefundSchema.parse(req.body);
  res.json(await svc.rejectRefund(businessScope(req), id, notes));
});
