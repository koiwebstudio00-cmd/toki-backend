import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { disconnectDb, withDb } from '../src/lib/db.js';
import { seal, unseal } from '../src/modules/mercadopago/crypto.js';
import { requestTokens } from '../src/modules/mercadopago/client.js';
import { authCtx, bearer, DB_AVAILABLE, ownerDb, seedTeam } from './helpers.js';

const mpConfig = {
  MP_INTEGRATION_ENABLED: true, MP_ENVIRONMENT: 'test' as const,
  MP_CLIENT_ID: '123456', MP_CLIENT_SECRET: 'test-client-secret',
  MP_REDIRECT_URI: 'http://localhost:5173/dashboard/settings/payments',
  MP_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32)
};
const initialConfig = { ...config };
const tokens = (seller = '12345') => ({
  access_token: 'access-secret', refresh_token: 'refresh-secret', user_id: seller,
  token_type: 'bearer', expires_in: 3600, live_mode: false, scope: 'read write offline_access'
});
const mockTokens = (data = tokens()) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))));

describe('Mercado Pago secrets and HTTP client', () => {
  afterEach(() => { Object.assign(config, initialConfig); vi.unstubAllGlobals(); });
  it('encrypts with random nonces and binds secrets to tenant and purpose', () => {
    Object.assign(config, mpConfig);
    const encrypted = seal('sensitive', 'business-a:access');
    expect(encrypted).not.toContain('sensitive');
    expect(seal('sensitive', 'business-a:access')).not.toBe(encrypted);
    expect(unseal(encrypted, 'business-a:access')).toBe('sensitive');
    expect(() => unseal(encrypted, 'business-b:access')).toThrow();
    expect(() => unseal(encrypted, 'business-a:refresh')).toThrow();
    expect(() => unseal(encrypted.slice(0, -2), 'business-a:access')).toThrow();
  });
  it('rejects wrong environments and missing permissions without leaking tokens', async () => {
    Object.assign(config, mpConfig);
    mockTokens({ ...tokens(), live_mode: true });
    await expect(requestTokens({ grant_type: 'refresh_token' })).rejects.toThrow(/ambiente/);
    mockTokens({ ...tokens(), scope: 'read' });
    await expect(requestTokens({ grant_type: 'refresh_token' })).rejects.toThrow(/permisos/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'access-secret' }), { status: 500 })));
    await expect(requestTokens({ grant_type: 'refresh_token' })).rejects.toThrow('Mercado Pago no pudo completar la conexión.');
  });
});

const app = buildApp();
const base = '/v1/integrations/mercadopago';
describe.runIf(DB_AVAILABLE)('Mercado Pago connection and tenant isolation', () => {
  let team: Awaited<ReturnType<typeof seedTeam>>;
  beforeAll(async () => { team = await seedTeam(); Object.assign(config, mpConfig); });
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { Object.assign(config, initialConfig); await disconnectDb(); await ownerDb().$disconnect(); });
  async function begin(user = team.owner) {
    const response = await request(app).post(`${base}/connect`).set(bearer(user)).send({});
    expect(response.status).toBe(201);
    const url = new URL(response.body.authorizationUrl);
    return { state: url.searchParams.get('state')!, url };
  }
  const complete = (state: string, user = team.owner) => request(app).post(`${base}/complete`).set(bearer(user)).send({ state, code: 'one-use-code' });

  it('defaults off, requires auth/admin and never enables checkout', async () => {
    await request(app).get(base).expect(401);
    await request(app).post(`${base}/connect`).set(bearer(team.staff)).send({}).expect(403);
    config.MP_INTEGRATION_ENABLED = false;
    const status = await request(app).get(base).set(bearer(team.owner)).expect(200);
    expect(status.body).toMatchObject({ available: false, collectionEnabled: false, status: 'disconnected' });
    await request(app).post(`${base}/connect`).set(bearer(team.owner)).send({}).expect(503);
    config.MP_INTEGRATION_ENABLED = true;
    await request(app).put('/v1/settings/payments').set(bearer(team.owner))
      .send({ cashEnabled: true, transferEnabled: false, mercadopagoEnabled: true }).expect(400);
  });
  it('uses PKCE, binds state to the initiating user/business and consumes it once', async () => {
    const flow = await begin();
    expect(flow.url.origin).toBe('https://auth.mercadopago.com.ar');
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url.searchParams.get('code_challenge')).toHaveLength(43);
    const stored = await ownerDb().mpOauthFlow.findFirstOrThrow();
    expect(stored.stateHash).not.toBe(flow.state);
    expect(stored.verifierCiphertext).toMatch(/^v1\./);
    mockTokens();
    await complete(flow.state, team.other).expect(409);
    await complete(flow.state, team.admin).expect(409);
    expect(fetch).not.toHaveBeenCalled();
    const response = await complete(flow.state).expect(200);
    expect(response.body).toMatchObject({ status: 'connected', sellerId: '12345', acceptanceMode: 'manual', collectionEnabled: false });
    expect(JSON.stringify(response.body)).not.toContain('secret');
    const connection = await ownerDb().mpConnection.findUniqueOrThrow({ where: { businessId_environment: { businessId: team.businessId, environment: 'test' } } });
    const credentials = await ownerDb().mpCredential.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(credentials.accessTokenCiphertext).not.toContain('access-secret');
    expect(credentials.refreshTokenCiphertext).not.toContain('refresh-secret');
    await complete(flow.state).expect(409);
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(sent).toMatchObject({ grant_type: 'authorization_code', client_id: '123456', redirect_uri: mpConfig.MP_REDIRECT_URI, test_token: 'true' });
    expect(sent.code_verifier).toHaveLength(43);
  });
  it('rejects expired and superseded flows before calling MP', async () => {
    const old = await begin();
    const current = await begin();
    mockTokens();
    await complete(old.state).expect(409);
    await ownerDb().mpOauthFlow.updateMany({ where: { businessId: team.businessId }, data: { expiresAt: new Date(0) } });
    await complete(current.state).expect(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not persist tokens if the initiating admin loses access during the exchange', async () => {
    const flow = await begin(team.admin);
    vi.stubGlobal('fetch', vi.fn(async () => {
      await ownerDb().businessMember.update({ where: { businessId_userId: { businessId: team.businessId, userId: team.admin.id } }, data: { role: 'staff' } });
      return new Response(JSON.stringify({ ...tokens(), access_token: 'must-not-be-saved' }));
    }));
    await complete(flow.state, team.admin).expect(403);
    const connection = await ownerDb().mpConnection.findUniqueOrThrow({ where: { businessId_environment: { businessId: team.businessId, environment: 'test' } } });
    const credentials = await ownerDb().mpCredential.findUniqueOrThrow({ where: { connectionId: connection.id } });
    expect(unseal(credentials.accessTokenCiphertext, `mp:test:${team.businessId}:access`)).toBe('access-secret');
    await ownerDb().businessMember.update({ where: { businessId_userId: { businessId: team.businessId, userId: team.admin.id } }, data: { role: 'admin' } });
    const next = await begin(); mockTokens(); await complete(next.state).expect(200);
  });
  it('rechecks membership after authorization started', async () => {
    const flow = await begin(team.admin);
    await ownerDb().businessMember.update({ where: { businessId_userId: { businessId: team.businessId, userId: team.admin.id } }, data: { role: 'staff' } });
    mockTokens();
    await complete(flow.state, team.admin).expect(403);
    expect(fetch).not.toHaveBeenCalled();
    await ownerDb().businessMember.update({ where: { businessId_userId: { businessId: team.businessId, userId: team.admin.id } }, data: { role: 'admin' } });
  });
  it('rotates credentials without returning them and preserves the receiver identity', async () => {
    mockTokens({ ...tokens(), access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
    const refreshed = await request(app).post(`${base}/refresh`).set(bearer(team.admin)).send({}).expect(200);
    expect(JSON.stringify(refreshed.body)).not.toContain('rotated');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-secret' });
    mockTokens(tokens('99999'));
    await request(app).post(`${base}/refresh`).set(bearer(team.owner)).send({}).expect(409);
    const status = await request(app).get(base).set(bearer(team.owner)).expect(200);
    expect(status.body).toMatchObject({ status: 'reconnect_required', sellerId: '12345' });
    const flow = await begin(); mockTokens(); await complete(flow.state).expect(200);
  });
  it('serializes refresh across callers and does not allow an overlapping authorization', async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const first = request(app).post(`${base}/refresh`).set(bearer(team.owner)).send({}).then(res => res);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await request(app).post(`${base}/refresh`).set(bearer(team.admin)).send({}).expect(409);
    await request(app).post(`${base}/connect`).set(bearer(team.owner)).send({}).expect(409);
    release(new Response(JSON.stringify(tokens())));
    expect((await first).status).toBe(200);
  });
  it('a token timeout requires reconnection rather than blindly reusing a rotating token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sensitive-network-error')));
    const res = await request(app).post(`${base}/refresh`).set(bearer(team.owner)).send({}).expect(503);
    expect(JSON.stringify(res.body)).not.toContain('sensitive');
    expect((await request(app).get(base).set(bearer(team.owner))).body.status).toBe('reconnect_required');
    await request(app).post(`${base}/refresh`).set(bearer(team.owner)).send({}).expect(409);
    expect(fetch).toHaveBeenCalledTimes(1);
    const flow = await begin(); mockTokens(); await complete(flow.state).expect(200);
  });
  it('one seller cannot be linked to two businesses', async () => {
    const flow = await begin(team.other); mockTokens();
    await complete(flow.state, team.other).expect(409);
    const other = await request(app).get(base).set(bearer(team.other));
    expect(other.body.sellerId).toBeNull();
  });
  it('settings require admin; RLS hides other businesses and all credential/event writes', async () => {
    await request(app).patch(base).set(bearer(team.staff)).send({ acceptanceMode: 'automatic' }).expect(403);
    const saved = await request(app).patch(base).set(bearer(team.admin)).send({ acceptanceMode: 'automatic' }).expect(200);
    expect(saved.body.acceptanceMode).toBe('automatic');
    expect((await request(app).get(base).set(bearer(team.other))).body.acceptanceMode).toBe('manual');
    const rows = await withDb(authCtx(team.staff), tx => tx.mpConnection.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.businessId).toBe(team.businessId);
    await expect(withDb(authCtx(team.owner), tx => tx.mpCredential.findMany())).rejects.toThrow();
    await expect(withDb(authCtx(team.owner), tx => tx.mpOauthFlow.findMany())).rejects.toThrow();
    await expect(withDb(authCtx(team.owner), tx => tx.mpWebhookEvent.findMany())).rejects.toThrow();
    await expect(withDb(authCtx(team.owner), tx => tx.mpConnection.updateMany({ data: { status: 'connected' } }))).rejects.toThrow();
    await expect(withDb({ role: 'anon' }, tx => tx.mpConnection.findMany())).rejects.toThrow();
  });
  it('enforces tenant FKs and only one active payment per order/register', async () => {
    const db = ownerDb();
    const a = await db.mpConnection.findUniqueOrThrow({ where: { businessId_environment: { businessId: team.businessId, environment: 'test' } } });
    const b = await db.mpConnection.findUniqueOrThrow({ where: { businessId_environment: { businessId: team.otherBusinessId, environment: 'test' } } });
    await expect(db.mpRegister.create({ data: { businessId: team.businessId, environment: 'test', connectionId: b.id, storeId: '1', posId: 'bad', channel: 'qr_static' } })).rejects.toThrow();
    const register = await db.mpRegister.create({ data: { businessId: team.businessId, environment: 'test', connectionId: a.id, storeId: '1', posId: '1', channel: 'qr_static' } });
    const order = await db.order.create({ data: { businessId: team.businessId, orderCode: 'TK-900001', customerName: 'Test', customerPhone: '12345', orderType: 'takeaway', subtotal: 1000, total: 1000 } });
    const foreignOrder = await db.order.create({ data: { businessId: team.otherBusinessId, orderCode: 'TK-900002', customerName: 'Test', customerPhone: '12345', orderType: 'takeaway', subtotal: 1000, total: 1000 } });
    const data = { businessId: team.businessId, environment: 'test', connectionId: a.id, registerId: register.id, orderId: order.id, expectedAmount: 1000, orderUpdatedAt: order.updatedAt, acceptanceMode: 'manual' };
    await expect(db.mpPaymentAttempt.create({ data: { ...data, orderId: foreignOrder.id, externalReference: randomUUID(), idempotencyKey: randomUUID() } })).rejects.toThrow();
    const attempt = await db.mpPaymentAttempt.create({ data: { ...data, externalReference: randomUUID(), idempotencyKey: randomUUID() } });
    await expect(db.mpPaymentAttempt.create({ data: { ...data, externalReference: randomUUID(), idempotencyKey: randomUUID() } })).rejects.toThrow();
    const secondOrder = await db.order.create({ data: { businessId: team.businessId, orderCode: 'TK-900003', customerName: 'Test', customerPhone: '12345', orderType: 'takeaway', subtotal: 1000, total: 1000 } });
    await expect(db.mpPaymentAttempt.create({ data: { ...data, orderId: secondOrder.id, externalReference: randomUUID(), idempotencyKey: randomUUID() } })).rejects.toThrow();
    const secondRegister = await db.mpRegister.create({ data: { businessId: team.businessId, environment: 'test', connectionId: a.id, storeId: '1', posId: '2', channel: 'qr_static' } });
    await expect(db.mpPaymentAttempt.create({ data: { ...data, registerId: secondRegister.id, externalReference: randomUUID(), idempotencyKey: randomUUID() } })).rejects.toThrow();
    await db.mpPaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'expired' } });
    await db.mpPaymentAttempt.create({ data: { ...data, externalReference: randomUUID(), idempotencyKey: randomUUID() } });
    expect(await withDb(authCtx(team.other), tx => tx.mpPaymentAttempt.count())).toBe(0);
    await expect(withDb(authCtx(team.owner), tx => tx.mpPaymentAttempt.updateMany({ data: { status: 'paid' } }))).rejects.toThrow();
    const event = { businessId: team.businessId, environment: 'test', connectionId: a.id, providerEventId: 'event-1', resourceId: 'ORD1', action: 'order.processed' };
    await db.mpWebhookEvent.create({ data: event });
    await expect(db.mpWebhookEvent.create({ data: event })).rejects.toThrow();
  });
});
