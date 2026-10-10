import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, raw } from "express";
import { config } from "../../config.js";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { envelope } from "./channel-schemas.js";
import { storeWebhook } from "./webhook-repo.js";
export { inboxEvent } from "./channel-schemas.js";

export async function acceptWebhook(body: unknown) {
  const event = envelope.parse(body);
  if (!["message.received", "message.sent", "message.failed", "conversation.control_changed"].includes(event.event)) return { accepted: true };
  // Other platforms may share the subscription. Never infer WhatsApp identity from them.
  if ((body as { message?: { platform?: string } }).message?.platform !== "whatsapp" && event.event !== "conversation.control_changed") return { accepted: true };
  return withDb(systemCtx, tx => storeWebhook(tx, body, event));
}

export const agentWebhookRoutes = Router();
agentWebhookRoutes.post("/v1/webhooks/zernio", raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  if (!config.ZERNIO_WEBHOOK_SECRET) throw new ApiError("SERVICE_UNAVAILABLE", "El canal todavía no está configurado.");
  const signature = req.get("X-Zernio-Signature") ?? "";
  if (!Buffer.isBuffer(req.body) || !/^[a-f0-9]{64}$/.test(signature)) throw new ApiError("UNAUTHORIZED", "Firma inválida.");
  const expected = createHmac("sha256", config.ZERNIO_WEBHOOK_SECRET).update(req.body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new ApiError("UNAUTHORIZED", "Firma inválida.");
  let body: unknown;
  try { body = JSON.parse(req.body.toString("utf8")); } catch { throw new ApiError("VALIDATION_ERROR", "Evento inválido."); }
  res.json(await acceptWebhook(body));
});
