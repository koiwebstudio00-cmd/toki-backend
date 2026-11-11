import type { Tx } from "../../lib/db.js";

export const accessSelect = { id: true, email: true, emailVerifiedAt: true, adminAccessEnabled: true,
  adminTotpSecretEncrypted: true, adminSessionVersion: true } as const;
export const accessUser = (tx: Tx, id: string) => tx.user.findUnique({ where: { id }, select: accessSelect });
export const lockUser = (tx: Tx, id: string) => tx.$queryRaw`select id from auth.users where id = ${id}::uuid for update`;
export const lockSetup = (tx: Tx, hash: string) => tx.$queryRaw`select id from auth.admin_activations where setup_token_hash = ${hash} for update`;
export const activationByLink = (tx: Tx, tokenHash: string) => tx.adminActivation.findUnique({ where: { tokenHash }, include: { user: { select: accessSelect } } });
export const activationBySetup = (tx: Tx, setupTokenHash: string) => tx.adminActivation.findUnique({ where: { setupTokenHash }, include: { user: { select: accessSelect } } });
export const activeSession = (tx: Tx, id: string, email: string, version: number) => tx.user.count({
  where: { id, email, emailVerifiedAt: { not: null }, adminAccessEnabled: true,
    adminTotpSecretEncrypted: { not: null }, adminSessionVersion: version }
});
export const consumeTotpStep = (tx: Tx, id: string, version: number, step: bigint) => tx.user.updateMany({
  where: { id, adminAccessEnabled: true, adminSessionVersion: version,
    OR: [{ lastAdminTotpStep: null }, { lastAdminTotpStep: { lt: step } }] },
  data: { lastAdminTotpStep: step }
});

// Sesiones recordadas (0027). Solo se guarda el hash del token de la cookie.
export const createRefreshToken = (tx: Tx, data: { userId: string; tokenHash: string; sessionVersion: number; expiresAt: Date; userAgent?: string }) =>
  tx.adminRefreshToken.create({ data, select: { id: true } });
export const refreshTokenByHash = (tx: Tx, tokenHash: string) => tx.adminRefreshToken.findUnique({ where: { tokenHash } });
export const revokeRefreshToken = (tx: Tx, id: string, replacedBy?: string) => tx.adminRefreshToken.updateMany({
  where: { id, revokedAt: null }, data: { revokedAt: new Date(), replacedBy: replacedBy ?? null }
});
export const revokeUserRefreshTokens = (tx: Tx, userId: string) => tx.adminRefreshToken.updateMany({
  where: { userId, revokedAt: null }, data: { revokedAt: new Date() }
});
