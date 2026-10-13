import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { systemCtx, withDb } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import { limitPerMinute } from '../../middleware/rateLimit.js';
import { numericId, resourceId } from './qr-client.js';
import { receiveEvent } from './qr-repo.js';
import { processingEnabled } from './qr-service.js';

const envelope = z.object({ id: z.union([numericId, z.string().min(1).max(100)]), type: z.literal('order'),
  action: z.string().regex(/^order\.[a-z_]+$/).max(80), live_mode: z.boolean(),
  user_id: numericId, application_id: numericId, data: z.object({ id: resourceId }) });

export function verifySignature(signature: string | undefined, requestId: string | undefined, dataId: string) {
  // Timestamp is signed but not aged out: MP retries can arrive much later. Durable dedup + GET is replay-safe.
  if (!signature || !requestId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) return false;
  const pieces = signature.split(',').map(piece => piece.trim().split('='));
  const ts = pieces.filter(([key]) => key === 'ts');
  const hashes = pieces.filter(([key]) => key === 'v1');
  if (ts.length !== 1 || hashes.length !== 1 || !/^\d{10,13}$/.test(ts[0]?.[1] ?? '') || !/^[a-f0-9]{64}$/i.test(hashes[0]?.[1] ?? '')) return false;
  const expected = createHmac('sha256', config.MP_WEBHOOK_SECRET)
    .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts[0]![1]};`).digest();
  return timingSafeEqual(expected, Buffer.from(hashes[0]![1]!, 'hex'));
}

export const mercadopagoWebhookRoutes = Router();
mercadopagoWebhookRoutes.post('/webhooks/mercadopago', limitPerMinute(300), async (req, res) => {
  processingEnabled();
  const dataId = resourceId.parse(req.query['data.id']);
  if (!verifySignature(req.get('x-signature'), req.get('x-request-id'), dataId)) throw new ApiError('UNAUTHORIZED', 'Firma de Mercado Pago inválida.');
  const event = envelope.parse(req.body);
  if (event.data.id !== dataId || event.application_id !== config.MP_CLIENT_ID || event.live_mode !== (config.MP_ENVIRONMENT === 'production')) {
    throw new ApiError('VALIDATION_ERROR', 'La notificación no corresponde a esta integración.');
  }
  await withDb(systemCtx, tx => receiveEvent(tx, { sellerId: event.user_id, environment: config.MP_ENVIRONMENT,
    eventId: event.id, resourceId: dataId, action: event.action }));
  res.set('Cache-Control', 'no-store').status(200).json({ received: true });
});
