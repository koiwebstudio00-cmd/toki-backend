import type { Request, RequestHandler, Response } from "express";
import { TOTP, Secret } from "otpauth";
import { config } from "../../config.js";
import { systemCtx, withDb, type Tx } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { ADMIN_ACCESS_TTL_SECONDS, addDays, randomToken, sha256, signAdminToken, verifyAdminToken } from "../../lib/tokens.js";
import { authenticatePassword } from "../auth/service.js";
import type { LoginInput } from "../auth/schemas.js";
import { unsealAdminSecret } from "./crypto.js";
import * as repo from "./repo.js";

/** Días que un dispositivo queda recordado desde el login con autenticador. No se extiende al renovar. */
export const ADMIN_REMEMBER_DAYS = 30;
/** Dos pestañas pueden renovar casi a la vez: reusar un token recién rotado no se trata como robo. */
const REUSE_GRACE_MS = 10_000;
const expired = () => new ApiError("UNAUTHORIZED", "Tu sesión de Toki Admin venció. Ingresá de nuevo.");

type AccessUser = { id: string; email: string; adminSessionVersion: number };
export interface RememberedSession {
  session: ReturnType<typeof adminSession>;
  refreshToken: string;
  rememberUntil: Date;
}

export function adminSession(user: AccessUser, rememberUntil?: Date) {
  return { accessToken: signAdminToken({ userId: user.id, email: user.email, version: user.adminSessionVersion }),
    expiresIn: ADMIN_ACCESS_TTL_SECONDS, email: user.email,
    ...(rememberUntil ? { rememberUntil: rememberUntil.toISOString() } : {}) };
}

/** Crea la sesión recordada dentro de la transacción que validó el acceso. */
export async function rememberAdmin(tx: Tx, user: AccessUser, userAgent?: string): Promise<RememberedSession> {
  const refreshToken = randomToken();
  const rememberUntil = addDays(ADMIN_REMEMBER_DAYS);
  await repo.createRefreshToken(tx, { userId: user.id, tokenHash: sha256(refreshToken), sessionVersion: user.adminSessionVersion,
    expiresAt: rememberUntil, userAgent: userAgent?.slice(0, 300) });
  return { session: adminSession(user, rememberUntil), refreshToken, rememberUntil };
}

export async function loginAdmin(input: LoginInput & { code: string }, userAgent?: string): Promise<RememberedSession> {
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
  const remembered = await withDb(systemCtx, async tx => {
    const result = await repo.consumeTotpStep(tx, user.id, user.adminSessionVersion, step);
    return result.count === 1 ? rememberAdmin(tx, user, userAgent) : null;
  });
  if (!remembered) throw new ApiError("UNAUTHORIZED", "Ese código ya se usó. Esperá al siguiente.");
  return remembered;
}

/** Rota el token de la cookie y emite un acceso nuevo de 15 minutos, sin volver a pedir contraseña ni código. */
export async function refreshAdmin(refreshToken: string | undefined, userAgent?: string): Promise<RememberedSession> {
  if (!refreshToken) throw expired();
  const outcome = await withDb(systemCtx, async tx => {
    const current = await repo.refreshTokenByHash(tx, sha256(refreshToken));
    if (!current) return null;
    if (current.revokedAt) {
      // Alguien presentó un token rotado hace rato: hay una copia. Se cierran todas las sesiones recordadas.
      if (current.replacedBy && Date.now() - current.revokedAt.getTime() > REUSE_GRACE_MS) await repo.revokeUserRefreshTokens(tx, current.userId);
      return null;
    }
    if (current.expiresAt <= new Date()) return null;
    const user = await repo.accessUser(tx, current.userId);
    if (!user?.adminAccessEnabled || !user.emailVerifiedAt || !user.adminTotpSecretEncrypted ||
      user.adminSessionVersion !== current.sessionVersion) return null;
    const nextToken = randomToken();
    const next = await repo.createRefreshToken(tx, { userId: user.id, tokenHash: sha256(nextToken),
      sessionVersion: current.sessionVersion, expiresAt: current.expiresAt, userAgent: userAgent?.slice(0, 300) });
    const { count } = await repo.revokeRefreshToken(tx, current.id, next.id);
    // Otra solicitud lo rotó en paralelo: se descarta esta (rollback del token nuevo).
    if (count !== 1) throw expired();
    return { session: adminSession(user, current.expiresAt), refreshToken: nextToken, rememberUntil: current.expiresAt };
  });
  // Se responde después del commit, para que una revocación en cadena quede guardada.
  if (!outcome) throw expired();
  return outcome;
}

export async function logoutAdmin(refreshToken: string | undefined) {
  if (!refreshToken) return;
  await withDb(systemCtx, async tx => {
    const current = await repo.refreshTokenByHash(tx, sha256(refreshToken));
    if (current) await repo.revokeRefreshToken(tx, current.id);
  });
}

// La cookie es httpOnly: el navegador la guarda, pero el JavaScript del panel no puede leerla.
// En producción usa el prefijo __Host- (exige HTTPS, Path=/ y sin Domain).
export const adminCookieName = () => config.NODE_ENV === "production" ? "__Host-toki_admin_session" : "toki_admin_session";
const cookieOptions = () => ({ httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "strict" as const, path: "/" });

export function readAdminCookie(req: Request): string | undefined {
  const name = adminCookieName();
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}
export function setAdminCookie(res: Response, remembered: RememberedSession) {
  res.cookie(adminCookieName(), remembered.refreshToken, { ...cookieOptions(), expires: remembered.rememberUntil });
}
export function clearAdminCookie(res: Response) {
  res.clearCookie(adminCookieName(), cookieOptions());
}

export const requireAdminSession: RequestHandler = async (req, _res, next) => {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) throw new ApiError("UNAUTHORIZED", "Ingresá a Toki Admin.");
  let claims;
  try { claims = verifyAdminToken(token); }
  catch { throw expired(); }
  const valid = await withDb(systemCtx, tx => repo.activeSession(tx, claims.userId, claims.email, claims.version));
  if (!valid) throw new ApiError("FORBIDDEN", "Esta cuenta no tiene acceso a Toki Admin.");
  req.auth = claims;
  next();
};
