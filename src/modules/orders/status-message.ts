import { config } from "../../config.js";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import type { BusinessScope } from "../../lib/request.js";
import { zernioFetch } from "../../lib/zernio.js";
import { integrationFor } from "../agent/channel-repo.js";
import { orderStatusReceiptIntent } from "../whatsapp/order-status-receipt.js";

const statusText = {
  pending: "Recibimos tu pedido.",
  confirmed: "Confirmamos tu pedido.",
  preparing: "Estamos preparando tu pedido.",
  ready: "Tu pedido está listo.",
  out_for_delivery: "Tu pedido va en camino.",
  delivered: "Tu pedido fue entregado.",
  cancelled: "Tu pedido fue cancelado."
};

export async function sendStatusMessage({ ctx, businessId }: BusinessScope, orderId: string, historyId: string) {
  const scopedOrder = await withDb(ctx, tx => tx.order.count({ where: { id: orderId, businessId } }));
  if (!scopedOrder) throw notFound("El pedido no existe.");

  const send = await withDb(systemCtx, async tx => {
    const order = await tx.order.findFirst({ where: { id: orderId, businessId }, select: {
      status: true, orderCode: true, whatsappConversationId: true, business: { select: { slug: true } },
      statusHistory: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, toStatus: true } }
    } });
    if (!order) throw notFound("El pedido no existe.");
    if (order.statusHistory[0]?.id !== historyId || order.statusHistory[0].toStatus !== order.status) {
      throw new ApiError("CONFLICT", "El estado cambió. Actualizá el pedido antes de enviar el aviso.");
    }
    const conversationId = order.whatsappConversationId;
    if (!conversationId) throw new ApiError("CONFLICT", "El pedido no tiene una conversación de WhatsApp vinculada.");
    const previous = await tx.whatsappMessage.findFirst({
      where: { id: historyId, businessId, conversationId, aiIntent: orderStatusReceiptIntent }
    });
    if (previous) {
      const receipt = previous.rawPayload as { accountId?: string; messageId?: string } | null;
      if (!receipt?.accountId || !receipt.messageId) {
        throw new ApiError("CONFLICT", "Hay un envío en curso o pendiente de verificar. Revisá WhatsApp antes de volver a enviarlo.");
      }
      const failure = await tx.agentWebhookEvent.findFirst({ where: { AND: [
        { failure: { path: ["accountId"], equals: receipt.accountId } },
        { failure: { path: ["messageId"], equals: receipt.messageId } }
      ] } });
      if (failure) throw new ApiError("CONFLICT", "WhatsApp informó que el aviso no se entregó. Abrí WhatsApp para contactar al cliente.");
      return null;
    }
    const latest = await tx.whatsappMessage.findFirst({
      where: { businessId, conversationId, direction: "inbound" },
      orderBy: [{ createdAt: "desc" }, { receivedAt: "desc" }, { id: "desc" }]
    });
    if (!latest || Date.now() - latest.createdAt.getTime() >= 24 * 3600_000) {
      throw new ApiError("CONFLICT", "El cliente no escribió en las últimas 24 horas. Abrí WhatsApp para enviar el aviso.");
    }
    const channel = await tx.agentTurn.findFirst({
      where: { businessId, conversationId, messageId: latest.id },
      select: { accountId: true, providerConversationId: true }
    });
    const integrations = channel ? await integrationFor(tx, channel.accountId) : [];
    if (!channel || !config.ZERNIO_API_KEY || integrations.length !== 1 || integrations[0]?.businessId !== businessId) {
      throw new ApiError("CONFLICT", "La cuenta vinculada a este chat no está disponible. Abrí WhatsApp para enviar el aviso.");
    }
    const tracking = `${config.FRONT_URL.replace(/\/+$/, "")}/${order.business.slug}/order/${order.orderCode}`;
    const message = `${statusText[order.status]}\nPedido ${order.orderCode}\nSeguimiento: ${tracking}`;
    // The history event is the durable key for this update, including after an uncertain provider response.
    const reservation = await tx.whatsappMessage.createMany({
      data: [{ id: historyId, businessId, conversationId, direction: "outbound", aiIntent: orderStatusReceiptIntent }],
      skipDuplicates: true
    });
    if (!reservation.count) throw new ApiError("CONFLICT", "Ya hay un envío para este estado. Revisá WhatsApp.");
    return { ...channel, conversationId, message };
  });
  if (!send) return { status: "already_sent" as const };

  try {
    const result = await zernioFetch<{ success: boolean; data?: { messageId?: string; partialFailure?: unknown } }>(
      `/inbox/conversations/${encodeURIComponent(send.providerConversationId)}/messages`, {
        method: "POST", idempotencyKey: historyId, body: { accountId: send.accountId, message: send.message }
      });
    const messageId = result.data?.messageId;
    if (!result.success || !messageId || result.data?.partialFailure) throw new Error("Unknown delivery");
    await withDb(systemCtx, async tx => {
      const now = new Date();
      await tx.whatsappMessage.update({
        where: { id: historyId }, data: { rawPayload: { accountId: send.accountId, messageId } }
      });
      await tx.whatsappMessage.createMany({ data: [{
        businessId, conversationId: send.conversationId, direction: "outbound", content: send.message,
        providerMessageId: messageId, aiIntent: "order_status_update", createdAt: now
      }], skipDuplicates: true });
      await tx.whatsappConversation.updateMany({
        where: { id: send.conversationId, businessId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: now } }] },
        data: { lastMessageAt: now }
      });
    });
  } catch {
    throw new ApiError("CONFLICT", "No pudimos confirmar el envío. Revisá el chat antes de intentar otro aviso.");
  }
  return { status: "sent" as const };
}
