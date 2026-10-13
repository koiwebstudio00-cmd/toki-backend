import { config } from '../../config.js';
import { processNext } from './qr-service.js';

export function startMercadoPagoWorker() {
  if (!config.MP_INTEGRATION_ENABLED || config.MP_WEBHOOK_SECRET.length < 16) return async () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      // Bounded batch; SKIP LOCKED and expiring leases also support multiple API instances.
      for (let i = 0; i < 10 && !stopped; i++) if (!await processNext()) break;
    } catch {
      console.error('[mercadopago] No se pudo procesar la cola. Se reintentará.');
    } finally {
      if (!stopped) timer = setTimeout(() => { running = tick(); }, 2000);
    }
  };
  running = tick();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
