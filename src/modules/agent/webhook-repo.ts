import { z } from "zod";
import type { Tx } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { id, inboxEvent, envelope } from "./channel-schemas.js";
import * as repo from "./channel-repo.js";
export async function storeWebhook(tx: Tx, body: unknown, event: ReturnType<typeof envelope.parse>) {

    const duplicate = await tx.agentWebhookEvent.createMany({ data: [{ id: event.id }], skipDuplicates: true });
    if (!duplicate.count) return { accepted: true, duplicate: true };
    if (event.event === "message.failed") {
      const failed = z.object({ account: z.object({ accountId: id }), message: z.object({ platformMessageId: id }) }).parse(body);
      await repo.lockDelivery(tx, failed.account.accountId, failed.message.platformMessageId);
      await tx.agentWebhookEvent.update({ where: { id: event.id }, data: { failure: { accountId: failed.account.accountId, messageId: failed.message.platformMessageId } } });
      const integrations = await repo.integrationFor(tx, failed.account.accountId);
      if (integrations.length !== 1) return { accepted: true };
      const turns = await tx.agentTurn.findMany({ where: { businessId: integrations[0]!.businessId, providerMessageId: failed.message.platformMessageId } });
      for (const turn of turns) {
        await tx.agentTurn.update({ where: { id: turn.id }, data: { status: "failed", errorCode: "delivery_failed" } });
        await repo.pauseConversation(tx, turn, "WhatsApp informó que la respuesta no se entregó.");
      }
      return { accepted: true };
    }
    if (event.event === "conversation.control_changed") {
      const control = z.object({ account: z.object({ accountId: id }), conversation: z.object({ id }), control: z.object({ owner: z.string() }) }).parse(body);
      if (control.control.owner !== "app") {
        const integrations = await repo.integrationFor(tx, control.account.accountId);
        if (integrations.length === 1) {
          const turns = await tx.agentTurn.findMany({ where: { businessId: integrations[0]!.businessId, providerConversationId: control.conversation.id }, distinct: ["conversationId"], take: 1 });
          if (turns[0]) await repo.pauseConversation(tx, turns[0], "Otra aplicación tomó la conversación.");
        }
      }
      return { accepted: true };
    }
    const input = inboxEvent.parse(body);
    const integrations = await repo.integrationFor(tx, input.account.accountId);
    if (integrations.length !== 1) return { accepted: true }; // Ambiguous routing fails closed.
    const integration = integrations[0]!;
    const businessId = integration.businessId;
    if (integration.business.botSettings?.engine !== "native") return { accepted: true };
    if (input.event === "message.sent") {
      // Outgoing sender is the business, not the customer. Resolve by the known channel binding.
      const bound = await tx.agentTurn.findFirst({ where: { businessId, accountId: input.account.accountId, providerConversationId: input.conversation.id } });
      if (bound && (input.message.sentVia === "human" || ["whatsapp_business_app", "meta_business_agent"].includes(input.message.source ?? input.source ?? ""))) {
        await repo.pauseConversation(tx, bound, "La conversación está siendo atendida desde WhatsApp.");
        await tx.whatsappMessage.createMany({ data: [{ businessId, conversationId: bound.conversationId, direction: "outbound", content: input.message.text, providerMessageId: input.message.platformMessageId, rawPayload: repo.json(input) }], skipDuplicates: true });
      }
      return { accepted: true };
    }
    if (input.message.direction !== "incoming") return { accepted: true };
    const contactId = input.message.sender.businessScopedUserId ?? input.message.sender.id;
    const phone = input.message.sender.phoneNumber ?? (/^\+?\d{7,16}$/.test(input.message.sender.id) ? input.message.sender.id : null);
    const conversation = await tx.whatsappConversation.upsert({ where: { businessId_contactId: { businessId, contactId } },
      create: { businessId, contactId, phone }, update: phone ? { phone } : {} });
    await tx.$queryRaw`select id from public.whatsapp_conversations where id=${conversation.id}::uuid for update`;
    // Original provider timestamp stops delayed/redelivered messages reopening the 24h window.
    const sentAt = new Date(input.message.sentAt);
    if (sentAt.getTime() > Date.now() + 300_000) throw new ApiError("VALIDATION_ERROR", "Fecha de mensaje inválida.");
    const attachment = input.message.attachments[0];
    const messageType = attachment ? (attachment.type === "file" ? "document" : ["image", "audio"].includes(attachment.type) ? attachment.type : "unknown") : "text";
    const inserted = await tx.whatsappMessage.createMany({ data: [{ businessId, conversationId: conversation.id,
      direction: "inbound", content: input.message.text, messageType, providerMessageId: input.message.platformMessageId,
      rawPayload: repo.json(input), createdAt: sentAt }], skipDuplicates: true });
    if (!inserted.count) return { accepted: true, duplicate: true };
    const message = await tx.whatsappMessage.findFirstOrThrow({ where: { businessId, providerMessageId: input.message.platformMessageId } });
    if (!conversation.lastMessageAt || sentAt > conversation.lastMessageAt) await tx.whatsappConversation.update({ where: { id: conversation.id }, data: { lastMessageAt: sentAt } });
    if (input.metadata?.standby) await repo.pauseConversation(tx, { businessId, conversationId: conversation.id }, "Otra aplicación está atendiendo la conversación.");
    await tx.agentTurn.create({ data: { businessId, conversationId: conversation.id, messageId: message.id,
      accountId: input.account.accountId, providerConversationId: input.conversation.id,
      status: input.metadata?.standby || conversation.status !== "open" || !integration.business.botSettings?.isEnabled ? "skipped" : "queued",
      availableAt: new Date(Date.now() + 6000) } });
    return { accepted: true };
}
