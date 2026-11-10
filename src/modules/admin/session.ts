import type { RequestHandler } from "express";
import { TOTP, Secret } from "otpauth";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { ADMIN_ACCESS_TTL_SECONDS, signAdminToken, verifyAdminToken } from "../../lib/tokens.js";
import { authenticatePassword } from "../auth/service.js";
import type { LoginInput } from "../auth/schemas.js";
import { unsealAdminSecret } from "./crypto.js";
import * as repo from "./repo.js";

export function adminSession(user: { id: string; email: string; adminSessionVersion: number }) {
  return { accessToken: signAdminToken({ userId: user.id, email: user.email, version: user.adminSessionVersion }),
    expiresIn: ADMIN_ACCESS_TTL_SECONDS, email: user.email };
}
export async function loginAdmin(input: LoginInput & { code: string }) {
  const identity = await authenticatePassword(input);
  const user = await withDb(systemCtx, tx => repo.accessUser(tx, identity.id));
  if (!user?.adminAccessEnabled || !user.emailVerifiedAt || !user.adminTotpSecretEncrypted) {
    throw new ApiError("FORBIDDEN", "Esta cuenta no tiene acceso a Toki Admin.");
  }
  const timestamp = Date.now();
  const totp = new TOTP({ secret: Secret.fromBase32(unsealAdminSecret(user.adminTotpSecretEncrypted, user.id)) });
  const delta = totp.validate({ token: input.code, timestamp, window: 1 });
  if (delta === null) throw new ApiError("UNAUTHORIZED", "El código de tu aplicación autenticadora no es válido.");
  const step = BigInt(Math.floor(timestamp / (totp.period * 1000)) + delta);
  const result = await withDb(systemCtx, tx => repo.consumeTotpStep(tx, user.id, user.adminSessionVersion, step));
  if (result.count !== 1) throw new ApiError("UNAUTHORIZED", "Ese código ya se usó. Esperá al siguiente.");
  return adminSession(user);
}
export const requireAdminSession: RequestHandler = async (req, _res, next) => {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) throw new ApiError("UNAUTHORIZED", "Ingresá a Toki Admin.");
  let claims;
  try { claims = verifyAdminToken(token); }
  catch { throw new ApiError("UNAUTHORIZED", "Tu sesión de Toki Admin venció. Ingresá de nuevo."); }
  const valid = await withDb(systemCtx, tx => repo.activeSession(tx, claims.userId, claims.email, claims.version));
  if (!valid) throw new ApiError("FORBIDDEN", "Esta cuenta no tiene acceso a Toki Admin.");
  req.auth = claims;
  next();
};
