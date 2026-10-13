import { config } from '../../config.js';
import { systemCtx, withDb } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import type { BusinessScope } from '../../lib/request.js';
import { unseal } from './crypto.js';
import { assertAdmin } from './repo.js';
import { parseOrder, posSchema, providerRequest, type ProviderOrder } from './qr-client.js';
import * as repo from './qr-repo.js';

export function enabled() {
  if (!config.MP_INTEGRATION_ENABLED || !config.MP_QR_ENABLED) throw new ApiError('SERVICE_UNAVAILABLE', 'Los cobros QR todavía no están habilitados.');
}
export function processingEnabled() {
  if (!config.MP_INTEGRATION_ENABLED || config.MP_WEBHOOK_SECRET.length < 16) throw new ApiError('SERVICE_UNAVAILABLE', 'La verificación de Mercado Pago no está habilitada.');
}
function user(scope: BusinessScope) {
  if (scope.ctx.role !== 'authenticated') throw new ApiError('UNAUTHORIZED', 'Sesión requerida.');
  return scope.ctx.userId;
}
function token(ciphertext: string, businessId: string) {
  return unseal(ciphertext, `mp:${config.MP_ENVIRONMENT}:${businessId}:access`);
}
export async function linkRegister(scope: BusinessScope, posId: string) {
  enabled();
  const { conn, secret } = await withDb(systemCtx, async tx => {
    await assertAdmin(tx, scope.businessId, user(scope));
    return repo.credentials(tx, scope.businessId, config.MP_ENVIRONMENT);
  });
  const parsed = posSchema.safeParse(await providerRequest(`/v2/pos/${posId}`, token(secret.accessTokenCiphertext, scope.businessId)));
  if (!parsed.success || parsed.data.id !== posId || parsed.data.user_id !== conn.sellerId) {
    throw new ApiError('CONFLICT', 'La caja debe pertenecer a esta cuenta y estar habilitada para cobros integrados.');
  }
  return withDb(systemCtx, tx => repo.saveRegister(tx, scope.businessId, user(scope), config.MP_ENVIRONMENT, conn.id, parsed.data));
}
export async function create(scope: BusinessScope, input: { orderId: string; registerId: string; requestId: string }) {
  enabled();
  const row = await withDb(systemCtx, tx => repo.reserve(tx, scope.businessId, user(scope), config.MP_ENVIRONMENT, input));
  return repo.attemptDto(row);
}
export function list(scope: BusinessScope, orderId: string) {
  if (!config.MP_INTEGRATION_ENABLED) return Promise.resolve([]);
  return withDb(scope.ctx, tx => repo.listAttempts(tx, scope.businessId, orderId, config.MP_ENVIRONMENT));
}
export function schedule(scope: BusinessScope, id: string, cancel: boolean) {
  processingEnabled();
  return withDb(systemCtx, tx => repo.schedule(tx, scope.businessId, user(scope), config.MP_ENVIRONMENT, id, cancel));
}

function observation(data: ProviderOrder): { state: string; review: string | null } {
  const payment = data.transactions.payments[0]!;
  if (data.status === 'processed' && payment.status === 'processed' && payment.status_detail === 'accredited' && data.status_detail === 'processed') return { state: 'paid', review: null };
  if (data.status === 'refunded' && data.status_detail === 'refunded' && payment.status === 'refunded') return { state: 'refunded', review: null };
  if (['processed', 'refunded'].includes(data.status) && ['processed', 'refunded'].includes(payment.status) && data.status_detail === 'partially_refunded') return { state: 'paid', review: 'partial_refund' };
  if (data.status === 'canceled' && payment.status === 'canceled') return { state: 'canceled', review: null };
  if (data.status === 'expired' && payment.status === 'expired') return { state: 'expired', review: null };
  if (data.status === 'created' && payment.status === 'created') return { state: 'pending', review: null };
  return { state: 'unknown', review: 'provider_state_unknown' };
}

/** One durable job. Provider I/O always runs outside a database transaction. */
export async function processNext(): Promise<boolean> {
  if (!config.MP_INTEGRATION_ENABLED || config.MP_WEBHOOK_SECRET.length < 16) return false;
  const attempt = await withDb(systemCtx, tx => repo.claim(tx, config.MP_ENVIRONMENT));
  if (!attempt) return false;
  try {
    const { conn, secret } = await withDb(systemCtx, tx => repo.credentials(tx, attempt.businessId, attempt.environment));
    if (conn.id !== attempt.connectionId) throw new ApiError('CONFLICT', 'Conexión incompatible.');
    const access = token(secret.accessTokenCiphertext, attempt.businessId);
    const body = attempt.requestBody as { config?: { qr?: { external_pos_id?: string } } } | null;
    const verify = (data: ProviderOrder) => {
      const payment = data.transactions.payments[0]!;
      if (data.user_id !== conn.sellerId || data.integration_data.application_id !== config.MP_CLIENT_ID ||
          data.external_reference !== attempt.externalReference || !attempt.expectedAmount.eq(data.total_amount) ||
          !attempt.expectedAmount.eq(payment.amount) || data.config.qr.external_pos_id !== body?.config?.qr?.external_pos_id ||
          (attempt.providerOrderId && attempt.providerOrderId !== data.id) ||
          (attempt.providerPaymentId && attempt.providerPaymentId !== payment.id)) {
        throw new ApiError('CONFLICT', 'El cobro recibido no coincide con el pedido.');
      }
    };
    let id = attempt.providerOrderId;
    if (!id) {
      // Never replay an unbound write indefinitely (provider idempotency retention is finite).
      if (!attempt.requestBody || Date.now() - attempt.createdAt.getTime() > 3600_000) {
        await withDb(systemCtx, tx => repo.fail(tx, attempt, 'creation_unresolved'));
        return true;
      }
      const created = parseOrder(await providerRequest('/v1/orders', access, { method: 'POST', key: attempt.idempotencyKey, body: attempt.requestBody }));
      verify(created);
      if (!(await withDb(systemCtx, tx => repo.saveProviderId(tx, attempt, created.id))).count) return true;
      id = created.id;
    }
    // Always read the authoritative resource, including after POST or a signed notification.
    let data = parseOrder(await providerRequest(`/v1/orders/${id}`, access));
    verify(data);
    if (data.id !== id) throw new ApiError('CONFLICT', 'El cobro no coincide.');
    if (attempt.cancelRequested && data.status === 'created') {
      // A separate, deterministic key for cancel; a lost reply is resolved by the next GET.
      await providerRequest(`/v1/orders/${id}/cancel`, access, { method: 'POST', key: `cancel-${attempt.idempotencyKey}` });
      data = parseOrder(await providerRequest(`/v1/orders/${id}`, access));
      verify(data);
      if (data.id !== id) throw new ApiError('CONFLICT', 'El cobro no coincide.');
    }
    const result = observation(data);
    await withDb(systemCtx, tx => repo.applyObservation(tx, attempt, data, result.state, result.review));
  } catch (error) {
    await withDb(systemCtx, tx => repo.fail(tx, attempt, error instanceof ApiError && error.code === 'CONFLICT' ? 'verification_mismatch' : null));
  }
  return true;
}
