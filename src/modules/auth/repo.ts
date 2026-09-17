// Queries del módulo auth. Las tablas de auth solo se tocan con service_role;
// membresías y perfil se leen como el usuario (RLS).
import type { Tx } from "../../lib/db.js";

export type EmailTokenPurpose = "verify_email" | "reset_password";

export const userSelect = {
  id: true,
  email: true,
  passwordHash: true,
  emailVerifiedAt: true,
  rawUserMetaData: true
} as const;

export function findUserByEmail(tx: Tx, email: string) {
  return tx.user.findUnique({ where: { email }, select: userSelect });
}

export function findUserById(tx: Tx, id: string) {
  return tx.user.findUnique({ where: { id }, select: userSelect });
}

export function createUser(tx: Tx, data: { email: string; passwordHash: string; fullName: string }) {
  // El trigger on_auth_user_created crea la fila de profiles con full_name.
  return tx.user.create({
    data: { email: data.email, passwordHash: data.passwordHash, rawUserMetaData: { full_name: data.fullName } },
    select: userSelect
  });
}

export function touchLastLogin(tx: Tx, userId: string) {
  return tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() }, select: { id: true } });
}

export function markEmailVerified(tx: Tx, userId: string) {
  return tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
}

export function setPassword(tx: Tx, userId: string, passwordHash: string) {
  return tx.user.update({ where: { id: userId }, data: { passwordHash }, select: { id: true } });
}

// ── Tokens de email ─────────────────────────────────────────────────────────

export function invalidateEmailTokens(tx: Tx, userId: string, purpose: EmailTokenPurpose) {
  return tx.emailToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
}

export function createEmailToken(tx: Tx, data: { userId: string; purpose: EmailTokenPurpose; tokenHash: string; expiresAt: Date }) {
  return tx.emailToken.create({ data, select: { id: true } });
}

/** Consume el token de forma atómica: solo una request puede usarlo. */
export async function consumeEmailToken(tx: Tx, tokenHash: string, purpose: EmailTokenPurpose) {
  const token = await tx.emailToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true, purpose: true, usedAt: true, expiresAt: true } });
  if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt <= new Date()) return null;
  const { count } = await tx.emailToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
  return count === 1 ? token : null;
}

// ── Refresh tokens ──────────────────────────────────────────────────────────

export function createRefreshToken(tx: Tx, data: { userId: string; tokenHash: string; expiresAt: Date; userAgent?: string }) {
  return tx.refreshToken.create({ data, select: { id: true } });
}

export function findRefreshToken(tx: Tx, tokenHash: string) {
  return tx.refreshToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, revokedAt: true, replacedBy: true }
  });
}

/** Revoca solo si seguía activo; devuelve cuántas filas cambió (0 = carrera perdida). */
export function revokeRefreshToken(tx: Tx, id: string, replacedBy?: string) {
  return tx.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), replacedBy: replacedBy ?? null } });
}

export function revokeAllRefreshTokens(tx: Tx, userId: string) {
  return tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

// ── Lecturas como usuario (RLS) ─────────────────────────────────────────────

export function listMemberships(tx: Tx, userId: string) {
  return tx.businessMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { role: true, business: { select: { id: true, name: true, slug: true, logoUrl: true, isActive: true } } }
  });
}

export function findProfile(tx: Tx, userId: string) {
  return tx.profile.findUnique({ where: { id: userId }, select: { fullName: true, phone: true, avatarUrl: true } });
}
