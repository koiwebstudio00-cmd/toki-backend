import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { disconnectDb, systemCtx, withDb } from '../src/lib/db.js';
import { seal } from '../src/modules/mercadopago/crypto.js';
import { processNext } from '../src/modules/mercadopago/qr-service.js';
import { claim, applyObservation } from '../src/modules/mercadopago/qr-repo.js';
import { parseOrder } from '../src/modules/mercadopago/qr-client.js';
import { verifySignature } from '../src/modules/mercadopago/webhook.js';
import { authCtx, bearer, DB_AVAILABLE, ownerDb, seedTeam } from './helpers.js';

const app = buildApp();
const base = '/v1/integrations/mercadopago';
const original = { ...config };
const qrConfig = { MP_INTEGRATION_ENABLED: true, MP_QR_ENABLED: true, MP_ENVIRONMENT: 'test' as const,
  MP_CLIENT_ID: '123456', MP_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), MP_WEBHOOK_SECRET: 'fake-webhook-secret-only-for-tests' };
const pos = { id: 111, user_id: 12345, name: 'Caja de prueba', external_id: 'TOKICAJA1', status: 'active', config: { qr: { operating_mode: 'pdv' } } };
const providerId = 'ORD01K371WBFDS4MD9JG0K8ZMECBE';
function signature(dataId: string, requestId = 'request-id', ts = '1742505638683') {
  return `ts=${ts},v1=${createHmac('sha256', config.MP_WEBHOOK_SECRET).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex')}`;
}
describe('Mercado Pago webhook signatures', () => {
  afterEach(() => Object.assign(config, original));
  it('uses lowercase resource id and rejects missing, tampered and duplicate signatures', () => {
    Object.assign(config, qrConfig);
    const valid = signature(providerId);
    expect(verifySignature(valid, 'request-id', providerId)).toBe(true);
    expect(verifySignature(valid, 'other-request', providerId)).toBe(false);
    expect(verifySignature(valid, 'request-id', `${providerId}0`)).toBe(false);
    expect(verifySignature(`${valid},ts=1742505638683`, 'request-id', providerId)).toBe(false);
    expect(verifySignature(undefined, 'request-id', providerId)).toBe(false);
  });
});

describe.runIf(DB_AVAILABLE)('Mercado Pago QR: collection, isolation and recovery', () => {
  let team: Awaited<ReturnType<typeof seedTeam>>;
  let registerId: string;
  let orderId: string;
  let connId: string;
  let providerState: 'created' | 'processed' | 'canceled' | 'refunded' = 'created';
  let override: Record<string, unknown> = {};
  let activeReference = '';
  const requests: { path: string; method: string; key?: string; body?: unknown }[] = [];
  const provider = () => ({
    id: providerId, type: 'qr', user_id: '12345', currency: 'ARS', country_code: 'ARG',
    external_reference: activeReference, total_amount: '1234.56', status: providerState, status_detail: providerState,
    integration_data: { application_id: '123456' }, config: { qr: { external_pos_id: 'TOKICAJA1', mode: 'static' } },
    transactions: { payments: [{ id: 'PAY01K371WBFDS4MD9JG0KCV6PRKQ', amount: '1234.56', status: providerState,
      status_detail: providerState === 'processed' ? 'accredited' : providerState }] }, ...override
  });
  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, method: init?.method ?? 'GET', key: new Headers(init?.headers).get('X-Idempotency-Key') ?? undefined,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (path === '/v2/pos/111') return Response.json(pos);
    if (path.endsWith('/cancel')) providerState = 'canceled';
    return Response.json(provider());
  };
  async function reserve(user = team.staff, requestId: string = randomUUID(), targetOrder = orderId) {
    const res = await request(app).post(`${base}/attempts`).set(bearer(user)).send({ requestId, registerId, orderId: targetOrder }).expect(202);
    activeReference = `toki_${res.body.id}`;
    return res.body as { id: string; status: string };
  }
  async function wake(id: string, cancel = false) {
    await request(app).post(`${base}/attempts/${id}/${cancel ? 'cancel' : 'check'}`).set(bearer(team.staff)).expect(202);
    await processNext();
  }
  async function webhook(extra: Record<string, unknown> = {}, sig = signature(providerId)) {
    return request(app).post(`/v1/webhooks/mercadopago?data.id=${providerId}&type=order`)
      .set({ 'x-signature': sig, 'x-request-id': 'request-id' }).send({ id: '987', type: 'order', action: 'order.processed', live_mode: false,
        application_id: '123456', user_id: 12345, data: { id: providerId, status: 'processed' }, ...extra });
  }
  beforeEach(async () => {
    Object.assign(config, qrConfig);
    team = await seedTeam(); requests.length = 0; override = {}; providerState = 'created';
    const conn = await ownerDb().mpConnection.create({ data: { businessId: team.businessId, environment: 'test', sellerId: '12345', status: 'connected', expiresAt: new Date(Date.now() + 3600_000) } });
    connId = conn.id;
    await ownerDb().mpCredential.create({ data: { connectionId: conn.id, accessTokenCiphertext: seal('fake-access', `mp:test:${team.businessId}:access`), refreshTokenCiphertext: 'unused', scope: 'read write offline_access' } });
    orderId = (await ownerDb().order.create({ data: { businessId: team.businessId, orderCode: 'TK-200001', orderType: 'takeaway', customerName: 'Prueba', customerPhone: '3815550000', total: 1234.56, subtotal: 1234.56 } })).id;
    vi.stubGlobal('fetch', vi.fn(mockFetch));
    registerId = (await request(app).post(`${base}/registers`).set(bearer(team.owner)).send({ posId: '111' }).expect(201)).body.id;
  });
  afterEach(() => { vi.unstubAllGlobals(); Object.assign(config, original); });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });

  it('validates account, integration mode and administrator role before linking a QR register', async () => {
    await request(app).post(`${base}/registers`).set(bearer(team.staff)).send({ posId: '111' }).expect(403);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...pos, user_id: 555 })));
    await request(app).post(`${base}/registers`).set(bearer(team.owner)).send({ posId: '111' }).expect(409);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...pos, config: { qr: { operating_mode: 'standalone' } } })));
    await request(app).post(`${base}/registers`).set(bearer(team.owner)).send({ posId: '111' }).expect(409);
  });
  it('runs DateTime transactions in UTC regardless of the PostgreSQL server timezone', async () => {
    const time = await withDb(systemCtx, tx => tx.$queryRaw<{ zone: string; millis: number }[]>`select current_setting('TimeZone') as zone, (extract(epoch from now()) * 1000)::float8 as millis`);
    expect(time[0]!.zone).toBe('UTC');
    expect(Math.abs(time[0]!.millis - Date.now())).toBeLessThan(2000);
  });
  it('isolates attempts between businesses, rejects client amounts and respects the QR flag', async () => {
    await request(app).get(`${base}/orders/${orderId}/attempts`).set(bearer(team.other)).expect(404);
    await request(app).post(`${base}/attempts`).set(bearer(team.other)).send({ orderId, registerId, requestId: randomUUID() }).expect(404);
    await request(app).post(`${base}/attempts`).set(bearer(team.owner)).send({ orderId, registerId, requestId: randomUUID(), amount: 1 }).expect(400);
    config.MP_QR_ENABLED = false;
    await request(app).post(`${base}/attempts`).set(bearer(team.owner)).send({ orderId, registerId, requestId: randomUUID() }).expect(503);
    expect(await ownerDb().mpPaymentAttempt.count()).toBe(0);
  });
  it('reserves only one active attempt per order and register under concurrent requests', async () => {
    const bodies = await Promise.all([reserve(), reserve()]);
    expect(bodies[0]!.id).toBe(bodies[1]!.id);
    const second = await ownerDb().order.create({ data: { businessId: team.businessId, orderCode: 'TK-200002', orderType: 'takeaway', customerName: 'Otro', customerPhone: '3815550001', total: 50, subtotal: 50 } });
    await request(app).post(`${base}/attempts`).set(bearer(team.owner)).send({ orderId: second.id, registerId, requestId: randomUUID() }).expect(409);
    expect(await ownerDb().mpPaymentAttempt.count()).toBe(1);
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: second.id } })).paymentMethod).toBe('cash');
  });
  it('blocks manual payment, total changes and order cancellation until the pending QR is resolved', async () => {
    await reserve();
    await request(app).post(`/v1/orders/${orderId}/mark-paid`).set(bearer(team.owner)).expect(400);
    await expect(withDb(authCtx(team.owner), tx => tx.order.update({ where: { id: orderId }, data: { total: 10, subtotal: 10 } }))).rejects.toThrow();
    await expect(withDb(authCtx(team.owner), tx => tx.$executeRaw`select public.update_order_status(${orderId}::uuid, 'cancelled', null)`)).rejects.toThrow();
    await expect(withDb(authCtx(team.owner), tx => tx.payment.create({ data: { businessId: team.businessId, orderId, provider: 'mercadopago', status: 'paid', amount: 1234.56 } }))).rejects.toThrow();
  });
  it('treats a signed webhook only as a wake-up and settles exactly once using the provider GET', async () => {
    const attempt = await reserve();
    await processNext();
    expect((await webhook()).status).toBe(200);
    await processNext();
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('pending');
    expect((await webhook({}, 'ts=1742505638683,v1=' + '00'.repeat(32))).status).toBe(401);
    expect((await webhook({ live_mode: true })).status).toBe(400);
    expect((await webhook({ data: { id: 'ORD01K371WBFDS4MD9JG0K8ZMECBF' } })).status).toBe(400);
    providerState = 'processed';
    await wake(attempt.id);
    await wake(attempt.id);
    expect((await webhook()).status).toBe(200);
    const order = await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ paymentStatus: 'paid', status: 'pending', paymentMethod: 'mercadopago' });
    expect(await ownerDb().payment.count({ where: { orderId, status: 'paid' } })).toBe(1);
    expect(await ownerDb().mpWebhookEvent.count()).toBe(1);
    expect(requests.some(r => r.path === `/v1/orders/${providerId}` && r.method === 'GET')).toBe(true);
    expect((await ownerDb().mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('paid');
  });
  it('captures the acceptance preference and automatically confirms a verified payment only once', async () => {
    await ownerDb().mpConnection.update({ where: { id: connId }, data: { acceptanceMode: 'automatic' } });
    const attempt = await reserve();
    await ownerDb().mpConnection.update({ where: { id: connId }, data: { acceptanceMode: 'manual' } });
    providerState = 'processed';
    await processNext(); await wake(attempt.id);
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('confirmed');
    expect(await ownerDb().orderStatusHistory.count({ where: { orderId, toStatus: 'confirmed' } })).toBe(1);
    await request(app).post(`/v1/orders/${orderId}/mark-paid`).set(bearer(team.owner)).expect(400);
  });
  it('cannot overwrite another payment by choosing its UUID as the request id', async () => {
    const otherOrder = await ownerDb().order.create({ data: { businessId: team.otherBusinessId, orderCode: 'TK-200003', orderType: 'takeaway', customerName: 'Otro negocio', customerPhone: '3815550002', subtotal: 9, total: 9 } });
    const payment = await ownerDb().payment.create({ data: { businessId: team.otherBusinessId, orderId: otherOrder.id, amount: 9, provider: 'cash', status: 'pending' } });
    await reserve(team.staff, payment.id); providerState = 'processed'; await processNext();
    expect((await ownerDb().payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('pending');
    const verified = await ownerDb().payment.findUniqueOrThrow({ where: { mpAttemptId: payment.id } });
    expect(verified.id).not.toBe(payment.id);
    expect(verified.businessId).toBe(team.businessId);
  });
  it.each([
    { total_amount: '1.00' }, { user_id: '5555' }, { currency: 'USD' },
    { external_reference: 'wrong' }, { integration_data: { application_id: '666' } },
    { config: { qr: { external_pos_id: 'OTHERCASHREGISTER', mode: 'static' } } },
  ])('never approves mismatching provider data: %j', async badData => {
    const attempt = await reserve(); providerState = 'processed'; override = badData;
    await processNext();
    expect(await ownerDb().payment.count({ where: { orderId, status: 'paid' } })).toBe(0);
    expect((await ownerDb().mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))).toMatchObject({ status: 'unknown', reviewReason: 'verification_mismatch' });
  });
  it('recovers a lost create response using the exact same body and idempotency key', async () => {
    const attempt = await reserve();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      await mockFetch(url, init); throw new Error('ambiguous network failure with secret');
    }));
    await processNext();
    const first = requests.find(r => r.path === '/v1/orders')!;
    expect((await ownerDb().mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('unknown');
    vi.stubGlobal('fetch', vi.fn(mockFetch)); providerState = 'processed';
    await wake(attempt.id);
    const posts = requests.filter(r => r.path === '/v1/orders');
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(first);
    expect(await ownerDb().payment.count({ where: { orderId, status: 'paid' } })).toBe(1);
    const repeated = await reserve(team.staff, attempt.id);
    expect(repeated.id).toBe(attempt.id); expect(await ownerDb().mpPaymentAttempt.count()).toBe(1);
  });
  it('does not retry an unresolved create after the recovery window or release its register', async () => {
    const attempt = await reserve();
    await ownerDb().mpPaymentAttempt.update({ where: { id: attempt.id }, data: { createdAt: new Date(Date.now() - 2 * 3600_000) } });
    await processNext();
    expect((await ownerDb().mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))).toMatchObject({ status: 'unknown', reviewReason: 'creation_unresolved', nextCheckAt: null });
    expect(requests.filter(r => r.path === '/v1/orders')).toHaveLength(0);
  });
  it('cancels through MP and restores manual collection only after the provider confirms', async () => {
    const attempt = await reserve(); await processNext(); await wake(attempt.id, true);
    expect((await ownerDb().mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('canceled');
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } })).paymentMethod).toBe('cash');
    await request(app).post(`/v1/orders/${orderId}/mark-paid`).set(bearer(team.owner)).expect(200);
  });
  it('reclaims abandoned leases and ignores the old worker response', async () => {
    const attempt = await reserve();
    const stale = (await withDb(systemCtx, tx => claim(tx, 'test')))!;
    expect(await withDb(systemCtx, tx => claim(tx, 'test'))).toBeNull();
    await ownerDb().mpPaymentAttempt.update({ where: { id: attempt.id }, data: { leaseUntil: new Date(0) } });
    const current = (await withDb(systemCtx, tx => claim(tx, 'test')))!;
    expect(current.leaseToken).not.toBe(stale.leaseToken);
    providerState = 'processed';
    await withDb(systemCtx, tx => applyObservation(tx, stale, parseOrder(provider()), 'paid', null));
    expect(await ownerDb().payment.count({ where: { orderId } })).toBe(0);
  });
  it('handles refunds and never reverts a refunded payment to paid on a stale response', async () => {
    const attempt = await reserve(); providerState = 'processed'; await processNext();
    providerState = 'refunded'; await wake(attempt.id);
    providerState = 'processed'; await wake(attempt.id);
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('refunded');
    expect((await ownerDb().mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).reviewReason).toBe('provider_state_regression');
  });
  it('shows partial refunds for review without automatically accepting the order', async () => {
    await ownerDb().mpConnection.update({ where: { id: connId }, data: { acceptanceMode: 'automatic' } });
    const attempt = await reserve(); providerState = 'processed'; override = { status_detail: 'partially_refunded' }; await processNext();
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
    expect((await ownerDb().mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).reviewReason).toBe('partial_refund');
    // A later snapshot without refund detail (or a network error) cannot silently accept it.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await wake(attempt.id);
    vi.stubGlobal('fetch', vi.fn(mockFetch)); override = {};
    await wake(attempt.id);
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
    expect((await ownerDb().mpPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).reviewReason).toBe('partial_refund');
  });
  it('continues webhook verification after new QR collection is disabled', async () => {
    const attempt = await reserve(); await processNext();
    config.MP_QR_ENABLED = false; providerState = 'processed';
    expect((await webhook()).status).toBe(200);
    await wake(attempt.id);
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('paid');
  });
  it('creates a refund incident for a late payment on a canceled order and reconciles the full refund', async () => {
    const attempt = await reserve(); await processNext(); await wake(attempt.id, true);
    await withDb(authCtx(team.owner), tx => tx.$executeRaw`select public.update_order_status(${orderId}::uuid, 'cancelled', null)`);
    providerState = 'processed'; await wake(attempt.id); await wake(attempt.id);
    expect((await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('cancelled');
    expect(await ownerDb().orderRefund.count({ where: { orderId, status: 'pending' } })).toBe(1);
    providerState = 'refunded'; await wake(attempt.id);
    expect(await ownerDb().orderRefund.count({ where: { orderId, status: 'completed' } })).toBe(1);
  });
});
