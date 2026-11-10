import { Secret, TOTP } from "otpauth";
import { config } from "../../config.js";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { hashPassword } from "../../lib/passwords.js";
import { randomToken, sha256 } from "../../lib/tokens.js";
import { sealAdminSecret, unsealAdminSecret } from "./crypto.js";
import { adminSession } from "./session.js";
import * as repo from "./repo.js";

const invalid = () => new ApiError("UNAUTHORIZED", "El enlace de activación no está disponible. Pedí uno nuevo al administrador.");
const ttlMs = 30 * 60_000;
function available(row: Awaited<ReturnType<typeof repo.activationByLink>>, setup = false) {
  return row && !row.usedAt && row.expiresAt > new Date() && row.failedAttempts < 5 &&
    row.sessionVersion === row.user.adminSessionVersion && (setup ? Boolean(row.startedAt) : !row.startedAt);
}
/** Operator-only operation. Never mounted on a public HTTP route. */
export async function createAdminActivation(email: string, reset = false) {
  if (!config.SUPERADMIN_EMAIL || email !== config.SUPERADMIN_EMAIL) throw new ApiError("FORBIDDEN", "El email no coincide con SUPERADMIN_EMAIL.");
  const url = new URL("/activar", config.ADMIN_FRONT_URL);
  if (config.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("ADMIN_FRONT_URL debe usar HTTPS.");
  // Validate server encryption before creating or changing any identity.
  sealAdminSecret("configuration-check", "bootstrap");
  const placeholder = await hashPassword(randomToken());
  const token = randomToken();
  await withDb(systemCtx, async tx => {
    const identity = await tx.user.upsert({ where: { email }, update: {}, create: {
      email, passwordHash: placeholder, rawUserMetaData: { full_name: "Administración de Toki" }
    }, select: { id: true } });
    await repo.lockUser(tx, identity.id);
    const user = await tx.user.findUniqueOrThrow({ where: { id: identity.id }, include: { _count: { select: { members: true } } } });
    if (user._count.members) throw new ApiError("CONFLICT", "Usá una cuenta administrativa dedicada, sin negocios asociados.");
    if (user.adminAccessEnabled && !reset) throw new ApiError("CONFLICT", "La cuenta ya está activa. Usá --reset solo para recuperar su acceso.");
    const now = new Date();
    const version = user.adminSessionVersion + 1;
    await tx.user.update({ where: { id: user.id }, data: { adminAccessEnabled: false, adminSessionVersion: version } });
    await tx.adminActivation.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now, passwordHash: null, totpSecretEncrypted: null } });
    await tx.adminActivation.create({ data: { userId: user.id, tokenHash: sha256(token), sessionVersion: version, expiresAt: new Date(Date.now() + ttlMs) } });
    await tx.signupInvitation.updateMany({ where: { email, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
  });
  url.hash = new URLSearchParams({ token }).toString();
  return { email, url: url.href };
}
export async function checkAdminActivation(token: string) {
  const row = await withDb(systemCtx, tx => repo.activationByLink(tx, sha256(token)));
  if (!available(row)) throw invalid();
  return { email: row!.user.email };
}
export async function startAdminActivation(input: { token: string; fullName: string; password: string }) {
  const passwordHash = await hashPassword(input.password);
  const setupToken = randomToken();
  const secret = new Secret({ size: 20 });
  const result = await withDb(systemCtx, async tx => {
    const row = await repo.activationByLink(tx, sha256(input.token));
    if (!available(row)) throw invalid();
    const sealed = sealAdminSecret(secret.base32, row!.userId);
    const claimed = await tx.adminActivation.updateMany({
      where: { id: row!.id, startedAt: null, usedAt: null, expiresAt: { gt: new Date() } },
      data: { startedAt: new Date(), setupTokenHash: sha256(setupToken), passwordHash, fullName: input.fullName, totpSecretEncrypted: sealed }
    });
    if (claimed.count !== 1) throw invalid();
    return { email: row!.user.email, expiresAt: row!.expiresAt.toISOString() };
  });
  const totp = new TOTP({ issuer: "Toki Admin", label: result.email, secret, algorithm: "SHA1", digits: 6, period: 30 });
  return { ...result, setupToken, secret: secret.base32, provisioningUri: totp.toString() };
}
export async function confirmAdminActivation(setupToken: string, code: string) {
  const outcome = await withDb(systemCtx, async tx => {
    const initial = await repo.activationBySetup(tx, sha256(setupToken));
    if (!initial) throw invalid();
    await repo.lockUser(tx, initial.userId);
    await repo.lockSetup(tx, sha256(setupToken));
    const row = await repo.activationBySetup(tx, sha256(setupToken));
    if (!available(row, true) || !row?.passwordHash || !row.fullName || !row.totpSecretEncrypted) throw invalid();

    const user = await repo.accessUser(tx, row.userId);
    if (!user || user.adminSessionVersion !== row.sessionVersion) throw invalid();
    const timestamp = Date.now();
    const totp = new TOTP({ secret: Secret.fromBase32(unsealAdminSecret(row.totpSecretEncrypted, row.userId)) });
    const delta = totp.validate({ token: code, timestamp, window: 1 });
    if (delta === null) {
      await tx.adminActivation.update({ where: { id: row.id }, data: { failedAttempts: { increment: 1 } } });
      return null;
    }
    const now = new Date();
    const updated = await tx.user.update({ where: { id: row.userId }, data: {
      passwordHash: row.passwordHash, emailVerifiedAt: now, adminAccessEnabled: true,
      adminTotpSecretEncrypted: row.totpSecretEncrypted, lastAdminTotpStep: BigInt(Math.floor(timestamp / 30_000) + delta)
    }, select: repo.accessSelect });
    await tx.profile.updateMany({ where: { id: row.userId }, data: { fullName: row.fullName } });
    await tx.adminActivation.update({ where: { id: row.id }, data: { usedAt: now, passwordHash: null, totpSecretEncrypted: null } });
    await tx.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.emailToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: now } });
    return updated;
  });
  if (!outcome) throw new ApiError("UNAUTHORIZED", "El código no es válido. Revisá el autenticador y volvé a intentar; el enlace admite cinco intentos.");
  return adminSession(outcome);
}
