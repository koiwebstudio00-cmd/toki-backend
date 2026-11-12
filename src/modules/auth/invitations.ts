
import { systemCtx, type Tx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { addDays, randomToken, sha256 } from "../../lib/tokens.js";

export function isSuperadmin(userId: string) {
  return withDb(systemCtx, async tx => Boolean(await tx.user.count({
    where: { id: userId, adminAccessEnabled: true, adminTotpSecretEncrypted: { not: null } }
  })));
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

const invitationPageSize = 30;

/** Todas las invitaciones, de la más reciente a la más antigua, de a 30 por página. */
export async function listInvitations(cursor?: string) {
  const rows = await withDb(systemCtx, tx => tx.signupInvitation.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: invitationPageSize + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: summary,
  }));
  const data = rows.slice(0, invitationPageSize);
  return { data, nextCursor: rows.length > invitationPageSize ? data.at(-1)!.id : null };
}

/**
 * Una sola invitación activa por email: al generar otra, las activas anteriores quedan revocadas
 * (mismo criterio que la activación de superadmins). `replaced` indica cuántas se revocaron.
 * Reactivar una invitación revocada o vencida es esta misma llamada: el código original no se
 * puede recuperar, porque en la base solo se guarda su hash.
 */
export async function createInvitation(email: string, userId: string | null) {
  const code = randomToken();
  const invitation = await withDb(systemCtx, async tx => {
    if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ApiError("CONFLICT", "Ya existe una cuenta con ese email.");
    }
    const now = new Date();
    const replaced = await tx.signupInvitation.updateMany({
      where: { email, usedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now }
    });
    const created = await tx.signupInvitation.create({
      data: { email, codeHash: sha256(code), createdBy: userId, expiresAt: addDays(7) }, select: summary
    });
    return { ...created, replaced: replaced.count };
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
