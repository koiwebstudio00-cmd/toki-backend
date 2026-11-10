import { config } from "../../config.js";
import { systemCtx, type Tx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { addDays, randomToken, sha256 } from "../../lib/tokens.js";

export function isSuperadmin(userId: string) {
  return config.SUPERADMIN_USER_IDS.includes(userId.toLowerCase());
}

const summary = { id: true, email: true, createdAt: true, expiresAt: true, usedAt: true, revokedAt: true } as const;
const invalidInvite = () => new ApiError("VALIDATION_ERROR", "La invitación no es válida, ya se usó o venció.");
const activeCode = (code: string, now: Date) => ({
  codeHash: sha256(code), expiresAt: { gt: now }, usedAt: null, revokedAt: null
});

export async function inspectInvitation(code: string) {
  const invite = await withDb(systemCtx, tx => tx.signupInvitation.findFirst({
    where: activeCode(code, new Date()), select: { email: true }
  }));
  if (!invite) throw invalidInvite();
  return invite;
}

export async function consumeInvitation(tx: Tx, code: string, email: string) {
  const now = new Date();
  const result = await tx.signupInvitation.updateMany({
    where: { ...activeCode(code, now), email }, data: { usedAt: now }
  });
  if (result.count !== 1) throw invalidInvite();
}

export function listInvitations() {
  return withDb(systemCtx, tx => tx.signupInvitation.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: summary
  }));
}

export async function createInvitation(email: string, userId: string | null) {
  const code = randomToken();
  const invitation = await withDb(systemCtx, async tx => {
    if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ApiError("CONFLICT", "Ya existe una cuenta con ese email.");
    }
    return tx.signupInvitation.create({
      data: { email, codeHash: sha256(code), createdBy: userId, expiresAt: addDays(7) }, select: summary
    });
  });
  return { ...invitation, code };
}

export async function revokeInvitation(id: string) {
  const now = new Date();
  const result = await withDb(systemCtx, tx => tx.signupInvitation.updateMany({
    where: { id, expiresAt: { gt: now }, usedAt: null, revokedAt: null }, data: { revokedAt: now }
  }));
  if (!result.count) throw new ApiError("CONFLICT", "La invitación ya no está activa.");
}
