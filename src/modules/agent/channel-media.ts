import { config } from "../../config.js";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { trustedWhatsappMediaUrl } from "../../lib/zernio.js";
import type { NativeScope } from "./actions.js";
import { inboxEvent } from "./webhook.js";
import { savePaymentProof } from "./service.js";
import * as repo from "./repo.js";

export async function saveChannelProof(scope: NativeScope, accountId: string, orderCode?: string) {
  if (!config.R2_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) {
    throw new ApiError("SERVICE_UNAVAILABLE", "No está disponible el almacenamiento de comprobantes. Una persona debe revisarlo.");
  }
  const media = await withDb(systemCtx, tx => repo.latestInboundMedia(tx, scope.businessId, scope.conversationId, new Date(Date.now() - 600_000)));
  const event = inboxEvent.safeParse(media?.rawPayload);
  if (!media || !event.success || event.data.account.accountId !== accountId || event.data.message.direction !== "incoming") {
    return { ok: false, error: "No hay una imagen o PDF reciente recibido en este canal." };
  }
  const attachment = event.data.message.attachments[0];
  if (!attachment) return { ok: false, error: "El mensaje no tiene adjuntos." };
  const mediaUrl = trustedWhatsappMediaUrl(attachment.url, accountId);
  return savePaymentProof({ ...scope, orderCode, mediaUrl, mediaType: media.messageType, providerMessageId: media.providerMessageId });
}
