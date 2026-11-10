import type { RequestHandler } from "express";
import { TOTP, Secret } from "otpauth";
import { config } from "../../config.js";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { ADMIN_ACCESS_TTL_SECONDS, signAdminToken, verifyAdminToken } from "../../lib/tokens.js";
import { authenticatePassword } from "../auth/service.js";
import { isSuperadmin } from "../auth/invitations.js";
import type { LoginInput } from "../auth/schemas.js";

function adminEnabled(userId: string, email: string) {
  return Boolean(config.SUPERADMIN_TOTP_SECRET && config.SUPERADMIN_EMAIL &&
    email.toLowerCase() === config.SUPERADMIN_EMAIL && isSuperadmin(userId));
}

export async function loginAdmin(input: LoginInput & { code: string }) {
  const user = await authenticatePassword(input);
  if (!adminEnabled(user.id, user.email)) throw new ApiError("FORBIDDEN", "Esta cuenta no tiene acceso a Toki Admin.");
  const timestamp = Date.now();
  const totp = new TOTP({ secret: Secret.fromBase32(config.SUPERADMIN_TOTP_SECRET) });
  const delta = totp.validate({ token: input.code, timestamp, window: 1 });
  if (delta === null) throw new ApiError("UNAUTHORIZED", "El código de tu aplicación autenticadora no es válido.");
  const step = BigInt(Math.floor(timestamp / (totp.period * 1000)) + delta);
  const result = await withDb(systemCtx, tx => tx.user.updateMany({
    where: { id: user.id, email: user.email, emailVerifiedAt: { not: null },
      OR: [{ lastAdminTotpStep: null }, { lastAdminTotpStep: { lt: step } }] },
    data: { lastAdminTotpStep: step }
  }));
  if (result.count !== 1) throw new ApiError("UNAUTHORIZED", "Ese código ya se usó. Esperá al siguiente.");
  return {
    accessToken: signAdminToken({ userId: user.id, email: user.email }),
    expiresIn: ADMIN_ACCESS_TTL_SECONDS,
    email: user.email
  };
}

export const requireAdminSession: RequestHandler = async (req, _res, next) => {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) throw new ApiError("UNAUTHORIZED", "Ingresá a Toki Admin.");
  let claims;
  try {
    claims = verifyAdminToken(token);
  } catch {
    throw new ApiError("UNAUTHORIZED", "Tu sesión de Toki Admin venció. Ingresá de nuevo.");
  }
  if (!adminEnabled(claims.userId, claims.email)) throw new ApiError("FORBIDDEN", "Esta cuenta no tiene acceso a Toki Admin.");
  const valid = await withDb(systemCtx, tx => tx.user.count({
    where: { id: claims.userId, email: claims.email, emailVerifiedAt: { not: null } }
  }));
  if (!valid) throw new ApiError("FORBIDDEN", "Esta cuenta no tiene acceso a Toki Admin.");
  req.auth = claims;
  next();
};
