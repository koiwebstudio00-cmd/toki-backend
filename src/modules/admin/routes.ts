import { Router } from "express";
import { z } from "zod";
import { idParams, uuid } from "../../lib/validation.js";
import { authLimiter, limitPerMinute } from "../../middleware/rateLimit.js";
import { emailOnlySchema, loginSchema } from "../auth/schemas.js";
import * as invitations from "../auth/invitations.js";
import { clearAdminCookie, loginAdmin, logoutAdmin, readAdminCookie, refreshAdmin, requireAdminSession, setAdminCookie } from "./session.js";
import * as admin from "./service.js";

import { activationCheckInput, activationStartInput, activationConfirmInput } from "./activation.schemas.js";
import { checkAdminActivation, startAdminActivation, confirmAdminActivation } from "./activation.js";

export const adminRoutes = Router();
const sessionInput = loginSchema.extend({ code: z.string().trim().regex(/^\d{6}$/, "Ingresá el código de seis dígitos.") });
const pageInput = z.object({ cursor: uuid("Página inválida.").optional(), q: z.string().trim().max(120).optional() });
const businessPageInput = pageInput.extend({ whatsapp: z.enum(["connected", "pending", "none"], { errorMap: () => ({ message: "Filtro de WhatsApp inválido." }) }).optional() });

adminRoutes.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
adminRoutes.post("/session", authLimiter(), async (req, res) => {
  const remembered = await loginAdmin(sessionInput.parse(req.body), req.get("user-agent"));
  setAdminCookie(res, remembered);
  res.json(remembered.session);
});
// Renueva el acceso con la cookie httpOnly del dispositivo recordado (30 días desde el login).
adminRoutes.post("/session/refresh", limitPerMinute(30), async (req, res) => {
  try {
    const remembered = await refreshAdmin(readAdminCookie(req), req.get("user-agent"));
    setAdminCookie(res, remembered);
    res.json(remembered.session);
  } catch (error) {
    clearAdminCookie(res);
    throw error;
  }
});
adminRoutes.post("/session/logout", limitPerMinute(30), async (req, res) => {
  await logoutAdmin(readAdminCookie(req));
  clearAdminCookie(res);
  res.json({ ok: true });
});

adminRoutes.post("/activation/check", authLimiter(), async (req, res) => {
  res.json(await checkAdminActivation(activationCheckInput.parse(req.body).token));
});
adminRoutes.post("/activation/start", authLimiter(), async (req, res) => {
  res.json(await startAdminActivation(activationStartInput.parse(req.body)));
});
adminRoutes.post("/activation/confirm", authLimiter(), async (req, res) => {
  const input = activationConfirmInput.parse(req.body);
  const remembered = await confirmAdminActivation(input.setupToken, input.code, req.get("user-agent"));
  setAdminCookie(res, remembered);
  res.json(remembered.session);
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
  const { cursor, q, whatsapp } = businessPageInput.parse(req.query);
  res.json(await admin.listBusinesses(cursor, q, whatsapp));
});

adminRoutes.get("/businesses/:id", async (req, res) => {
  res.json(await admin.businessDetail(idParams.parse(req.params).id));
});

adminRoutes.get("/users/:id", async (req, res) => {
  res.json(await admin.userDetail(idParams.parse(req.params).id));
});

adminRoutes.get("/orders/:id", async (req, res) => {
  res.json(await admin.orderDetail(idParams.parse(req.params).id));
});

adminRoutes.get("/orders", async (req, res) => {
  const { cursor, q } = pageInput.parse(req.query);
  res.json(await admin.listOrders(cursor, q));
});

adminRoutes.get("/invitations", async (req, res) => {
  const { cursor } = pageInput.pick({ cursor: true }).parse(req.query);
  res.json(await invitations.listInvitations(cursor));
});

adminRoutes.post("/invitations", async (req, res) => {
  const { email } = emailOnlySchema.parse(req.body);
  res.status(201).json(await invitations.createInvitation(email, req.auth!.userId));
});

adminRoutes.post("/invitations/:id/revoke", async (req, res) => {
  await invitations.revokeInvitation(idParams.parse(req.params).id);
  res.json({ ok: true });
});
