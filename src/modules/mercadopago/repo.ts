import type { MpConnection } from '@prisma/client';
import type { Tx } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';

export async function assertAdmin(tx: Tx, businessId: string, userId: string) {
  const member = await tx.businessMember.findUnique({ where: { businessId_userId: { businessId, userId } } });
  if (!member || !['owner', 'admin'].includes(member.role)) {
    throw new ApiError('FORBIDDEN', 'Tu rol no permite configurar Mercado Pago.');
  }
}
export function connection(tx: Tx, businessId: string, environment: string) {
  return tx.mpConnection.findUnique({ where: { businessId_environment: { businessId, environment } } });
}
export function registers(tx: Tx, businessId: string, environment: string) {
  return tx.mpRegister.findMany({ where: { businessId, environment }, orderBy: { createdAt: 'asc' } });
}
export function publicConnection(row: MpConnection | null) {
  if (!row) return { status: 'disconnected', sellerId: null, acceptanceMode: 'manual', connectedAt: null, expiresAt: null };
  const staleRefresh = row.refreshStartedAt && Date.now() - row.refreshStartedAt.getTime() > 60_000;
  const expired = row.expiresAt && row.expiresAt.getTime() <= Date.now();
  return {
    status: row.status === 'connected' && (staleRefresh || expired) ? 'reconnect_required' : row.status,
    sellerId: row.sellerId, acceptanceMode: row.acceptanceMode,
    connectedAt: row.connectedAt, expiresAt: row.expiresAt
  };
}

export async function beginFlow(tx: Tx, input: {
  businessId: string; environment: string; userId: string; stateHash: string;
  verifierCiphertext: string; redirectUri: string; expiresAt: Date;
}) {
  await assertAdmin(tx, input.businessId, input.userId);
  const row = await tx.mpConnection.upsert({
    where: { businessId_environment: { businessId: input.businessId, environment: input.environment } },
    create: { businessId: input.businessId, environment: input.environment }, update: {}
  });
  const updated = await tx.mpConnection.updateMany({
    where: { id: row.id, OR: [{ refreshStartedAt: null }, { refreshStartedAt: { lt: new Date(Date.now() - 60_000) } }] },
    data: { oauthGeneration: { increment: 1 }, refreshStartedAt: null }
  });
  if (!updated.count) throw new ApiError('CONFLICT', 'Ya hay una conexión de Mercado Pago en proceso. Esperá un momento.');
  const current = await tx.mpConnection.findUniqueOrThrow({ where: { id: row.id } });
  await tx.mpOauthFlow.deleteMany({ where: { businessId: input.businessId, expiresAt: { lt: new Date() } } });
  await tx.mpOauthFlow.create({ data: { ...input, connectionId: row.id, generation: current.oauthGeneration } });
}

/** Claim a one-use flow and a per-connection lease before any external call. */
export async function claimFlow(tx: Tx, stateHash: string, businessId: string, userId: string, environment: string) {
  await assertAdmin(tx, businessId, userId);
  const flow = await tx.mpOauthFlow.findFirst({
    where: { stateHash, businessId, userId, environment, consumedAt: null, expiresAt: { gt: new Date() } }
  });
  if (!flow) throw new ApiError('CONFLICT', 'La conexión venció o ya fue utilizada. Volvé a iniciarla.');
  const lease = new Date();
  const claimed = await tx.mpOauthFlow.updateMany({
    where: { stateHash, consumedAt: null }, data: { consumedAt: lease }
  });
  const locked = await tx.mpConnection.updateMany({
    where: { id: flow.connectionId, oauthGeneration: flow.generation, refreshStartedAt: null },
    data: { refreshStartedAt: lease }
  });
  if (!claimed.count || !locked.count) throw new ApiError('CONFLICT', 'Esta conexión fue reemplazada o ya está en proceso.');
  return { flow, lease };
}

export async function claimRefresh(tx: Tx, businessId: string, userId: string, environment: string) {
  await assertAdmin(tx, businessId, userId);
  const row = await connection(tx, businessId, environment);
  if (!row || row.status !== 'connected') throw new ApiError('CONFLICT', 'Primero conectá tu cuenta de Mercado Pago.');
  const lease = new Date();
  const locked = await tx.mpConnection.updateMany({
    where: { id: row.id, oauthGeneration: row.oauthGeneration, refreshStartedAt: null, status: 'connected' },
    data: { refreshStartedAt: lease }
  });
  if (!locked.count) throw new ApiError('CONFLICT', 'Ya hay una renovación en proceso. Si no termina, volvé a conectar la cuenta.');
  const credentials = await tx.mpCredential.findUnique({ where: { connectionId: row.id } });
  if (!credentials) throw new ApiError('CONFLICT', 'Volvé a conectar tu cuenta de Mercado Pago.');
  return { row, credentials, lease };
}

export async function saveTokens(tx: Tx, input: {
  connectionId: string; businessId: string; userId: string; environment: string; generation: number;
  lease: Date; sellerId: string; expiresAt: Date; accessTokenCiphertext: string; refreshTokenCiphertext: string; scope: string;
}) {
  await assertAdmin(tx, input.businessId, input.userId);
  const current = await connection(tx, input.businessId, input.environment);
  if (!current || current.id !== input.connectionId || (current.sellerId && current.sellerId !== input.sellerId)) {
    throw new ApiError('CONFLICT', 'La cuenta de Mercado Pago no coincide con la vinculada a este negocio.');
  }
  const updated = await tx.mpConnection.updateMany({
    where: { id: input.connectionId, oauthGeneration: input.generation, refreshStartedAt: input.lease },
    data: { sellerId: input.sellerId, status: 'connected', expiresAt: input.expiresAt, connectedAt: current.connectedAt ?? new Date(), refreshStartedAt: null }
  });
  if (!updated.count) throw new ApiError('CONFLICT', 'La conexión cambió mientras se autorizaba. Volvé a conectar la cuenta.');
  const credentials = { accessTokenCiphertext: input.accessTokenCiphertext, refreshTokenCiphertext: input.refreshTokenCiphertext, scope: input.scope };
  await tx.mpCredential.upsert({ where: { connectionId: input.connectionId }, create: { connectionId: input.connectionId, ...credentials }, update: credentials });
}
export function failLease(tx: Tx, id: string, generation: number, lease: Date) {
  return tx.mpConnection.updateMany({
    where: { id, oauthGeneration: generation, refreshStartedAt: lease },
    data: { refreshStartedAt: null, status: 'reconnect_required' }
  });
}
export async function updateSettings(tx: Tx, businessId: string, userId: string, environment: string, acceptanceMode: string) {
  await assertAdmin(tx, businessId, userId);
  const result = await tx.mpConnection.updateMany({ where: { businessId, environment }, data: { acceptanceMode } });
  if (!result.count) throw new ApiError('CONFLICT', 'Primero iniciá la conexión con Mercado Pago.');
}
