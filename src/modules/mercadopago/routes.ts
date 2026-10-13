import { Router } from 'express';
import { businessScope } from '../../lib/request.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin, requireBusiness } from '../../middleware/business.js';
import { limitPerMinute } from '../../middleware/rateLimit.js';
import { completeConnectionSchema, connectionSettingsSchema } from './schemas.js';
import * as svc from './service.js';
import * as qr from './qr-service.js';
import { z } from 'zod';

export const mercadopagoRoutes = Router();
mercadopagoRoutes.use(requireAuth, requireBusiness);
mercadopagoRoutes.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
mercadopagoRoutes.get('/', async (req, res) => { res.json(await svc.get(businessScope(req))); });
mercadopagoRoutes.get('/orders/:orderId/attempts', async (req, res) => {
  res.json(await qr.list(businessScope(req), z.string().uuid().parse(req.params.orderId)));
});
mercadopagoRoutes.post('/attempts', limitPerMinute(30), async (req, res) => {
  const input = z.object({ orderId: z.string().uuid(), registerId: z.string().uuid(), requestId: z.string().uuid() }).strict().parse(req.body);
  res.status(202).json(await qr.create(businessScope(req), input));
});
for (const action of ['check', 'cancel'] as const) {
  mercadopagoRoutes.post(`/attempts/:id/${action}`, limitPerMinute(30), async (req, res) => {
    res.status(202).json(await qr.schedule(businessScope(req), z.string().uuid().parse(req.params.id), action === 'cancel'));
  });
}
mercadopagoRoutes.use(requireAdmin, limitPerMinute(10));
mercadopagoRoutes.post('/registers', async (req, res) => {
  const { posId } = z.object({ posId: z.string().regex(/^[1-9]\d{0,29}$/) }).strict().parse(req.body);
  res.status(201).json(await qr.linkRegister(businessScope(req), posId));
});
mercadopagoRoutes.post('/connect', async (req, res) => { res.status(201).json(await svc.connect(businessScope(req))); });
// Frontend callback submits its code using the initiating user's authenticated session.
mercadopagoRoutes.post('/complete', async (req, res) => {
  res.json(await svc.complete(businessScope(req), completeConnectionSchema.parse(req.body)));
});
mercadopagoRoutes.post('/refresh', async (req, res) => { res.json(await svc.refresh(businessScope(req))); });
mercadopagoRoutes.patch('/', async (req, res) => {
  res.json(await svc.settings(businessScope(req), connectionSettingsSchema.parse(req.body).acceptanceMode));
});
