import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import {
  emailOnlySchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  tokenOnlySchema
} from "./schemas.js";
import * as auth from "./service.js";

export const authRoutes = Router();

const limiter = authLimiter();

authRoutes.post("/auth/register", limiter, async (req, res) => {
  await auth.register(registerSchema.parse(req.body));
  res.status(201).json({ ok: true, message: "Te mandamos un email para confirmar tu cuenta." });
});

authRoutes.post("/auth/verify-email", async (req, res) => {
  const { token } = tokenOnlySchema.parse(req.body);
  await auth.verifyEmail(token);
  res.json({ ok: true });
});

authRoutes.post("/auth/resend-verification", limiter, async (req, res) => {
  const { email } = emailOnlySchema.parse(req.body);
  await auth.resendVerification(email);
  res.json({ ok: true, message: "Si la cuenta existe y falta confirmarla, te mandamos un email." });
});

authRoutes.post("/auth/login", limiter, async (req, res) => {
  res.json(await auth.login(loginSchema.parse(req.body), req.get("user-agent")));
});

authRoutes.post("/auth/refresh", async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  res.json(await auth.refresh(refreshToken, req.get("user-agent")));
});

authRoutes.post("/auth/logout", requireAuth, async (req, res) => {
  const body = logoutSchema.parse(req.body ?? {});
  await auth.logout(req.auth!.userId, body.refreshToken, body.all ?? false);
  res.json({ ok: true });
});

authRoutes.post("/auth/forgot-password", limiter, async (req, res) => {
  const { email } = emailOnlySchema.parse(req.body);
  await auth.forgotPassword(email);
  res.json({ ok: true, message: "Si el email está registrado, te mandamos un link para restablecer la contraseña." });
});

authRoutes.post("/auth/reset-password", limiter, async (req, res) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  await auth.resetPassword(token, password);
  res.json({ ok: true });
});

authRoutes.get("/auth/me", requireAuth, async (req, res) => {
  const requested = req.get("x-business-id");
  res.json(await auth.me(req.auth!.userId, req.auth!.email, requested));
});
