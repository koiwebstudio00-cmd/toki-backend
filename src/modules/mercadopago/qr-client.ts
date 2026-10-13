import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';

export const numericId = z.union([z.number().int().positive().safe(), z.string().regex(/^\d{1,30}$/)]).transform(String);
export const resourceId = z.string().regex(/^ORD[A-Z0-9]{10,60}$/);
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const state = z.string().min(1).max(80);
export const posSchema = z.object({
  id: numericId, user_id: numericId, name: z.string().max(200).optional(),
  store_id: numericId.optional(), external_id: z.string().regex(/^[A-Za-z0-9]{1,40}$/),
  status: z.literal('active'), config: z.object({ qr: z.object({ operating_mode: z.literal('pdv') }) })
});
export const providerOrderSchema = z.object({
  id: resourceId, type: z.literal('qr'), user_id: numericId,
  currency: z.literal('ARS'), country_code: z.enum(['ARG', 'AR']),
  external_reference: z.string().max(64), total_amount: money,
  status: state, status_detail: state,
  integration_data: z.object({ application_id: numericId }),
  config: z.object({ qr: z.object({ external_pos_id: z.string(), mode: z.literal('static') }) }),
  transactions: z.object({ payments: z.array(z.object({
    id: z.string().regex(/^PAY[A-Z0-9]{10,60}$/), amount: money, status: state, status_detail: state
  })).length(1) })
});
export type ProviderOrder = z.infer<typeof providerOrderSchema>;

/** No raw responses/errors leave this boundary; ambiguous writes remain reserved. */
export async function providerRequest(path: string, token: string, options: { body?: unknown; key?: string; method?: string } = {}): Promise<unknown> {
  try {
    const response = await fetch(`https://api.mercadopago.com${path}`, {
      method: options.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json',
        ...(options.key ? { 'X-Idempotency-Key': options.key } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch {
    throw new ApiError('SERVICE_UNAVAILABLE', 'No pudimos verificar el cobro con Mercado Pago. El intento se conserva para volver a consultar.');
  }
}

export function parseOrder(value: unknown): ProviderOrder {
  const parsed = providerOrderSchema.safeParse(value);
  if (!parsed.success) throw new ApiError('CONFLICT', 'La respuesta de Mercado Pago requiere revisión. No se confirmó el pago.');
  return parsed.data;
}
