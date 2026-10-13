import { randomUUID } from 'node:crypto';
import type { MpPaymentAttempt } from '@prisma/client';
import type { Tx } from '../../lib/db.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { connection, assertAdmin } from './repo.js';
import type { ProviderOrder } from './qr-client.js';

export const activeStates = ['created', 'pending', 'unknown'];
const persistentReview = new Set(['partial_refund', 'late_payment', 'multiple_payments', 'order_requires_review']);
export async function assertMember(tx: Tx, businessId: string, userId: string) {
  if (!await tx.businessMember.findUnique({ where: { businessId_userId: { businessId, userId } } })) throw new ApiError('FORBIDDEN', 'No tenés acceso a este negocio.');
}
export async function credentials(tx: Tx, businessId: string, environment: string) {
  const conn = await connection(tx, businessId, environment);
  if (!conn || conn.status !== 'connected' || !conn.sellerId || !conn.expiresAt || conn.expiresAt <= new Date() || conn.refreshStartedAt) {
    throw new ApiError('CONFLICT', 'Volvé a conectar o renovar tu cuenta de Mercado Pago.');
  }
  const secret = await tx.mpCredential.findUnique({ where: { connectionId: conn.id } });
  if (!secret) throw new ApiError('CONFLICT', 'Volvé a conectar tu cuenta de Mercado Pago.');
  return { conn, secret };
}
export async function allowVerifiedWrite(tx: Tx) {
  await tx.$executeRaw`select set_config('toki.mp_write', 'true', true)`;
}
async function lockOrder(tx: Tx, businessId: string, orderId: string) {
  await tx.$queryRaw`select id from public.orders where id = ${orderId}::uuid and business_id = ${businessId}::uuid for update`;
  const order = await tx.order.findFirst({ where: { id: orderId, businessId } });
  if (!order) throw notFound('El pedido no existe.');
  return order;
}
export async function saveRegister(tx: Tx, businessId: string, userId: string, environment: string,
  connId: string, pos: { id: string; external_id: string; name?: string; store_id?: string }) {
  await assertAdmin(tx, businessId, userId);
  const { conn } = await credentials(tx, businessId, environment);
  if (conn.id !== connId) throw new ApiError('CONFLICT', 'La conexión cambió. Volvé a validar la caja.');
  const existing = await tx.mpRegister.findUnique({ where: { environment_posId: { environment, posId: pos.id } } });
  if (existing) {
    if (existing.connectionId !== connId || existing.externalPosId !== pos.external_id) throw new ApiError('CONFLICT', 'La caja ya está vinculada con otra configuración.');
    return existing;
  }
  return tx.mpRegister.create({ data: { businessId, environment, connectionId: connId, posId: pos.id,
    externalPosId: pos.external_id, name: pos.name, storeId: pos.store_id, channel: 'qr_static', enabled: true } });
}

export async function reserve(tx: Tx, businessId: string, userId: string, environment: string,
  input: { orderId: string; registerId: string; requestId: string }) {
  await assertMember(tx, businessId, userId);
  const order = await lockOrder(tx, businessId, input.orderId);
  const previous = await tx.mpPaymentAttempt.findUnique({ where: { id: input.requestId } });
  if (previous) {
    if (previous.businessId !== businessId || previous.orderId !== input.orderId || previous.registerId !== input.registerId || previous.environment !== environment) throw new ApiError('CONFLICT', 'Este intento corresponde a otro cobro.');
    return previous;
  }
  const active = await tx.mpPaymentAttempt.findFirst({ where: { orderId: order.id, status: { in: activeStates } } });
  if (active) {
    if (active.environment !== environment) throw new ApiError('CONFLICT', 'El pedido tiene un cobro en otro ambiente.');
    return active;
  }
  if (['cancelled', 'delivered'].includes(order.status) || order.paymentStatus === 'paid' || order.paymentStatus === 'refunded' || order.total.lte(0)) {
    throw new ApiError('CONFLICT', 'Este pedido no admite un nuevo cobro QR.');
  }
  if (await tx.payment.count({ where: { orderId: order.id, status: { in: ['paid', 'refunded'] } } })) throw new ApiError('CONFLICT', 'El pedido ya tiene un pago registrado.');
  const { conn } = await credentials(tx, businessId, environment);
  const register = await tx.mpRegister.findFirst({ where: { id: input.registerId, businessId, environment, connectionId: conn.id, enabled: true, channel: 'qr_static' } });
  if (!register?.externalPosId) throw new ApiError('CONFLICT', 'Elegí una caja QR habilitada.');
  const externalReference = `toki_${input.requestId}`;
  const amount = order.total.toFixed(2);
  await allowVerifiedWrite(tx);
  await tx.order.update({ where: { id: order.id }, data: { paymentMethod: 'mercadopago', paymentStatus: 'pending' } });
  return tx.mpPaymentAttempt.create({ data: {
    id: input.requestId, businessId, environment, connectionId: conn.id, registerId: register.id, orderId: order.id,
    expectedAmount: order.total, orderUpdatedAt: order.updatedAt, externalReference, idempotencyKey: randomUUID(),
    acceptanceMode: conn.acceptanceMode, originalPaymentMethod: order.paymentMethod, nextCheckAt: new Date(),
    requestBody: { type: 'qr', total_amount: amount, description: 'Pedido Toki', external_reference: externalReference,
      expiration_time: 'PT15M', config: { qr: { external_pos_id: register.externalPosId, mode: 'static' } },
      transactions: { payments: [{ amount }] } }
  } });
}

export function attemptDto(row: MpPaymentAttempt) {
  return { id: row.id, orderId: row.orderId, registerId: row.registerId, amount: row.expectedAmount.toNumber(),
    status: row.status, reviewReason: row.reviewReason, providerOrderId: row.providerOrderId,
    acceptanceMode: row.acceptanceMode, cancelRequested: row.cancelRequested,
    lastCheckedAt: row.lastCheckedAt, confirmedAt: row.confirmedAt, createdAt: row.createdAt };
}
export async function listAttempts(tx: Tx, businessId: string, orderId: string, environment: string) {
  if (!await tx.order.count({ where: { id: orderId, businessId } })) throw notFound('El pedido no existe.');
  return (await tx.mpPaymentAttempt.findMany({ where: { businessId, orderId, environment }, orderBy: { createdAt: 'desc' } })).map(attemptDto);
}
export async function schedule(tx: Tx, businessId: string, userId: string, environment: string, id: string, cancel: boolean) {
  await assertMember(tx, businessId, userId);
  const row = await tx.mpPaymentAttempt.findFirst({ where: { id, businessId, environment } });
  if (!row) throw notFound('El cobro no existe.');
  await tx.mpPaymentAttempt.update({ where: { id }, data: { nextCheckAt: new Date(), ...(cancel && activeStates.includes(row.status) ? { cancelRequested: true } : {}) } });
  return attemptDto(row);
}
export async function claim(tx: Tx, environment: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`select id from public.mp_payment_attempts
    where environment = ${environment} and next_check_at <= now() and (lease_until is null or lease_until < now())
    order by next_check_at limit 1 for update skip locked`;
  if (!rows[0]) return null;
  return tx.mpPaymentAttempt.update({ where: { id: rows[0].id }, data: { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) } });
}
export async function saveProviderId(tx: Tx, attempt: MpPaymentAttempt, providerId: string) {
  return tx.mpPaymentAttempt.updateMany({ where: { id: attempt.id, leaseToken: attempt.leaseToken }, data: { providerOrderId: providerId } });
}
export async function fail(tx: Tx, attempt: MpPaymentAttempt, review: string | null) {
  const delay = Math.min(300_000, 15_000 * 2 ** Math.min(attempt.failureCount, 5));
  await tx.mpPaymentAttempt.updateMany({ where: { id: attempt.id, leaseToken: attempt.leaseToken }, data: {
    status: activeStates.includes(attempt.status) ? 'unknown' : attempt.status,
    leaseToken: null, leaseUntil: null, failureCount: { increment: 1 },
    reviewReason: attempt.reviewReason && persistentReview.has(attempt.reviewReason) ? attempt.reviewReason : review ?? 'verification_unavailable',
    nextCheckAt: review === 'creation_unresolved' ? null : new Date(Date.now() + delay)
  } });
}

/** Lease serialization prevents stale HTTP responses from overwriting a newer observation. */
export async function applyObservation(tx: Tx, attempt: MpPaymentAttempt, data: ProviderOrder, state: string, review: string | null) {
  const order = await lockOrder(tx, attempt.businessId, attempt.orderId);
  await tx.$queryRaw`select id from public.mp_payment_attempts where id = ${attempt.id}::uuid for update`;
  const current = await tx.mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  if (current.leaseToken !== attempt.leaseToken) return;
  // A stale provider observation can never erase a paid/refunded result.
  if ((current.status === 'refunded' && state !== 'refunded') || (current.status === 'paid' && !['paid','refunded'].includes(state))) {
    state = current.status; review = 'provider_state_regression';
  }
  if (state !== 'refunded' && current.reviewReason && persistentReview.has(current.reviewReason)) review = current.reviewReason;
  const now = new Date();
  const payment = data.transactions.payments[0]!;
  const wasTerminal = !activeStates.includes(current.status);
  if (state === 'paid' && wasTerminal && current.status !== 'paid') review = 'late_payment';
  if (['paid','refunded'].includes(state) && (!order.total.eq(attempt.expectedAmount) || order.status === 'cancelled')) review = 'order_requires_review';
  await allowVerifiedWrite(tx);
  await tx.mpPaymentAttempt.update({ where: { id: attempt.id }, data: {
    providerOrderId: data.id, providerPaymentId: payment.id, providerStatus: data.status, providerStatusDetail: data.status_detail,
    status: state, reviewReason: review, confirmedAt: ['paid','refunded'].includes(state) ? current.confirmedAt ?? now : null,
    lastCheckedAt: now, failureCount: 0, leaseToken: null, leaseUntil: null,
    nextCheckAt: activeStates.includes(state) ? new Date(Date.now() + 30_000) :
      state === 'paid' && Date.now() - current.createdAt.getTime() < 80 * 86400_000 ? new Date(Date.now() + 3600_000) : null
  } });
  if (['paid','refunded'].includes(state)) {
    const status = state === 'refunded' ? 'refunded' : 'paid';
    await tx.payment.upsert({ where: { mpAttemptId: attempt.id }, create: {
      mpAttemptId: attempt.id, businessId: attempt.businessId, orderId: order.id, provider: 'mercadopago', status,
      amount: attempt.expectedAmount, externalPaymentId: payment.id,
      metadata: { verification: 'mercadopago_orders_api', attemptId: attempt.id, environment: attempt.environment }
    }, update: { status } });
    // Never overwrite a newer/different payment; flag unexpected late settlement for support.
    const otherPaid = await tx.payment.count({ where: { orderId: order.id, status: 'paid',
      OR: [{ mpAttemptId: null }, { mpAttemptId: { not: attempt.id } }] } });
    if (!otherPaid) {
      await tx.order.update({ where: { id: order.id }, data: { paymentMethod: 'mercadopago', paymentStatus: status } });
      if (state === 'paid' && !review && attempt.acceptanceMode === 'automatic' && order.status === 'pending') {
        // System transition: no user impersonation; manual transitions still use update_order_status.
        await tx.order.update({ where: { id: order.id }, data: { status: 'confirmed' } });
        await tx.orderStatusHistory.create({ data: { businessId: attempt.businessId, orderId: order.id,
          fromStatus: 'pending', toStatus: 'confirmed', note: 'Confirmado automáticamente: pago verificado por Mercado Pago.' } });
      }
    } else {
      await tx.mpPaymentAttempt.update({ where: { id: attempt.id }, data: { reviewReason: 'multiple_payments' } });
    }
    if (state === 'paid' && order.status === 'cancelled' && !await tx.orderRefund.count({ where: { orderId: order.id, reason: 'cancelacion', status: { not: 'rejected' } } })) {
      await tx.orderRefund.create({ data: { businessId: attempt.businessId, orderId: order.id, amount: attempt.expectedAmount,
        reason: 'cancelacion', originalPaymentMethod: 'mercadopago', notes: 'Pago verificado por Mercado Pago después de cancelar el pedido. Revisar devolución.' } });
    }
    if (state === 'refunded' && !otherPaid) {
      await tx.orderRefund.updateMany({ where: { orderId: order.id, reason: 'cancelacion', status: 'pending', amount: attempt.expectedAmount },
        data: { status: 'completed', completedAt: now, notes: 'Devolución total verificada mediante la API de Mercado Pago.' } });
    }
  } else if (['canceled','expired','failed'].includes(state) && !wasTerminal && order.paymentStatus === 'pending') {
    await tx.order.update({ where: { id: order.id }, data: {
      paymentMethod: attempt.originalPaymentMethod === 'transfer' ? 'transfer' : 'cash'
    } });
  }
}

export async function receiveEvent(tx: Tx, input: { sellerId: string; environment: string; eventId: string; resourceId: string; action: string }) {
  const conn = await tx.mpConnection.findUnique({ where: { environment_sellerId: { environment: input.environment, sellerId: input.sellerId } } });
  if (!conn) return;
  // HMAC authenticates the resource id, not arbitrary body fields. Deduplicate using the signed resource too.
  const eventId = `${input.resourceId}:${input.eventId}`;
  const inserted = await tx.mpWebhookEvent.createMany({ skipDuplicates: true, data: [{
    businessId: conn.businessId, environment: input.environment, connectionId: conn.id,
    providerEventId: eventId, resourceId: input.resourceId, action: input.action, status: 'processed', processedAt: new Date()
  }] });
  if (!inserted.count) return;
  // Durable wake-up. Unbound attempts replay the same POST to recover their id after a crash.
  await tx.mpPaymentAttempt.updateMany({ where: { connectionId: conn.id,
    OR: [{ providerOrderId: input.resourceId }, { providerOrderId: null, status: { in: activeStates } }] },
    data: { nextCheckAt: new Date() } });
}
