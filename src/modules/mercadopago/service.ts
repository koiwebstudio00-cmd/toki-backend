import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { systemCtx, withDb } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import type { BusinessScope } from '../../lib/request.js';
import { sha256 } from '../../lib/tokens.js';
import { requestTokens, type ProviderTokens } from './client.js';
import { seal, unseal } from './crypto.js';
import * as repo from './repo.js';

function enabled() {
  if (!config.MP_INTEGRATION_ENABLED) throw new ApiError('SERVICE_UNAVAILABLE', 'La conexión de Mercado Pago todavía no está habilitada.');
}
function userId(scope: BusinessScope) {
  if (scope.ctx.role !== 'authenticated') throw new ApiError('UNAUTHORIZED', 'Sesión requerida.');
  return scope.ctx.userId;
}
const secretContext = (businessId: string, purpose: string) => `mp:${config.MP_ENVIRONMENT}:${businessId}:${purpose}`;

export async function get(scope: BusinessScope) {
  if (!config.MP_INTEGRATION_ENABLED) return { available: false, collectionEnabled: false, environment: config.MP_ENVIRONMENT, ...repo.publicConnection(null), registers: [] };
  return withDb(scope.ctx, async tx => ({
    available: true, collectionEnabled: config.MP_QR_ENABLED, environment: config.MP_ENVIRONMENT,
    ...repo.publicConnection(await repo.connection(tx, scope.businessId, config.MP_ENVIRONMENT)),
    registers: await repo.registers(tx, scope.businessId, config.MP_ENVIRONMENT)
  }));
}

export async function connect(scope: BusinessScope) {
  enabled();
  const state = randomBytes(32).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await withDb(systemCtx, tx => repo.beginFlow(tx, {
    businessId: scope.businessId, environment: config.MP_ENVIRONMENT, userId: userId(scope),
    stateHash: sha256(state), verifierCiphertext: seal(verifier, secretContext(scope.businessId, `pkce:${sha256(state)}`)),
    redirectUri: config.MP_REDIRECT_URI, expiresAt
  }));
  const url = new URL('https://auth.mercadopago.com.ar/authorization');
  url.search = new URLSearchParams({
    client_id: config.MP_CLIENT_ID, response_type: 'code', platform_id: 'mp',
    redirect_uri: config.MP_REDIRECT_URI, state, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url')
  }).toString();
  return { authorizationUrl: url.toString(), expiresAt };
}

async function persist(scope: BusinessScope, connectionId: string, generation: number, lease: Date, tokens: ProviderTokens) {
  await withDb(systemCtx, tx => repo.saveTokens(tx, {
    connectionId, generation, lease, businessId: scope.businessId, userId: userId(scope), environment: config.MP_ENVIRONMENT,
    sellerId: tokens.user_id, expiresAt: new Date(Date.now() + tokens.expires_in * 1000), scope: tokens.scope,
    accessTokenCiphertext: seal(tokens.access_token, secretContext(scope.businessId, 'access')),
    refreshTokenCiphertext: seal(tokens.refresh_token, secretContext(scope.businessId, 'refresh'))
  }));
}

export async function complete(scope: BusinessScope, input: { state: string; code: string }) {
  enabled();
  const { flow, lease } = await withDb(systemCtx, tx => repo.claimFlow(tx, sha256(input.state), scope.businessId, userId(scope), config.MP_ENVIRONMENT));
  try {
    const tokens = await requestTokens({
      grant_type: 'authorization_code', code: input.code, redirect_uri: flow.redirectUri,
      code_verifier: unseal(flow.verifierCiphertext, secretContext(scope.businessId, `pkce:${flow.stateHash}`))
    });
    await persist(scope, flow.connectionId, flow.generation, lease, tokens);
  } catch (error) {
    await withDb(systemCtx, tx => repo.failLease(tx, flow.connectionId, flow.generation, lease));
    throw error;
  }
  return get(scope);
}

export async function refresh(scope: BusinessScope) {
  enabled();
  const { row, credentials, lease } = await withDb(systemCtx, tx => repo.claimRefresh(tx, scope.businessId, userId(scope), config.MP_ENVIRONMENT));
  try {
    const tokens = await requestTokens({ grant_type: 'refresh_token', refresh_token: unseal(credentials.refreshTokenCiphertext, secretContext(scope.businessId, 'refresh')) });
    await persist(scope, row.id, row.oauthGeneration, lease, tokens);
  } catch (error) {
    await withDb(systemCtx, tx => repo.failLease(tx, row.id, row.oauthGeneration, lease));
    throw error;
  }
  return get(scope);
}

export async function settings(scope: BusinessScope, acceptanceMode: 'manual' | 'automatic') {
  enabled();
  await withDb(systemCtx, tx => repo.updateSettings(tx, scope.businessId, userId(scope), config.MP_ENVIRONMENT, acceptanceMode));
  return get(scope);
}
