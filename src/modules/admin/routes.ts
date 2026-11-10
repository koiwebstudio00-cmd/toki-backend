import { Router } from "express";
import { z } from "zod";
import { idParams, uuid } from "../../lib/validation.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import { emailOnlySchema, loginSchema } from "../auth/schemas.js";
import * as invitations from "../auth/invitations.js";
import { loginAdmin, requireAdminSession } from "./session.js";
import * as admin from "./service.js";

import { activationCheckInput, activationStartInput, activationConfirmInput } from "./activation.schemas.js";
import { checkAdminActivation, startAdminActivation, confirmAdminActivation } from "./activation.js";

export const adminRoutes = Router();
const sessionInput = loginSchema.extend({ code: z.string().trim().regex(/^\d{6}$/, "Ingresá el código de seis dígitos.") });
const pageInput = z.object({ cursor: uuid("Página inválida.").optional(), q: z.string().trim().max(120).optional() });

adminRoutes.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
adminRoutes.post("/session", authLimiter(), async (req, res) => {
  res.json(await loginAdmin(sessionInput.parse(req.body)));
});

adminRoutes.post("/activation/check", authLimiter(), async (req, res) => {
  res.json(await checkAdminActivation(activationCheckInput.parse(req.body).token));
});
adminRoutes.post("/activation/start", authLimiter(), async (req, res) => {
  res.json(await startAdminActivation(activationStartInput.parse(req.body)));
});
adminRoutes.post("/activation/confirm", authLimiter(), async (req, res) => {
  const input = activationConfirmInput.parse(req.body);
  res.json(await confirmAdminActivation(input.setupToken, input.code));
});

adminRoutes.use(requireAdminSession);
adminRoutes.get("/session", (req, res) => { res.json({ email: req.auth!.email }); });
adminRoutes.get("/overview", async (req, res) => {
  const days = z.enum(["7", "30", "90"]).default("30").parse(req.query.days);
  res.json(await admin.overview(days === "7" ? 7 : days === "90" ? 90 : 30));
});

adminRoutes.get("/users", async (req, res) => {
  const { cursor, q } = pageInput.parse(req.query);
  res.json(await admin.listUsers(cursor, q));
});

adminRoutes.get("/businesses", async (req, res) => {
  const { cursor, q } = pageInput.parse(req.query);
  res.json(await admin.listBusinesses(cursor, q));
});

adminRoutes.get("/orders", async (req, res) => {
  const { cursor, q } = pageInput.parse(req.query);
  res.json(await admin.listOrders(cursor, q));
});

adminRoutes.get("/invitations", async (_req, res) => {
  res.json({ data: await invitations.listInvitations() });
});

adminRoutes.post("/invitations", async (req, res) => {
  const { email } = emailOnlySchema.parse(req.body);
  res.status(201).json(await invitations.createInvitation(email, req.auth!.userId));
});

adminRoutes.post("/invitations/:id/revoke", async (req, res) => {
  await invitations.revokeInvitation(idParams.parse(req.params).id);
  res.json({ ok: true });
});
