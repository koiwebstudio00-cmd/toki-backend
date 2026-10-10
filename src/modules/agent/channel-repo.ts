import type { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/db.js";
import type { NativeScope } from "./actions.js";

export const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const channelSettings = (tx: Tx, businessId: string) => tx.botSettings.findUnique({ where: { businessId } });
export const integrationFor = (tx: Tx, accountId: string) => tx.whatsappIntegration.findMany({
  where: { providerExternalId: accountId, isActive: true, business: { isActive: true } }, take: 2,
  select: { businessId: true, business: { select: { botSettings: true } } }
});
export const messageHistory = (tx: Tx, scope: NativeScope) => tx.whatsappMessage.findMany({
  where: { businessId: scope.businessId, conversationId: scope.conversationId }, orderBy: [{ createdAt: "desc" }, { receivedAt: "desc" }, { id: "desc" }], take: 30
});
export async function claimTurn(tx: Tx, now: Date) {
  // Serialize only the very short claim. Model and provider calls never hold a DB lock.
  await tx.$executeRaw`select pg_advisory_xact_lock(71640501)`;
  const rows = await tx.$queryRaw<{ id: string }[]>`select t.id from public.agent_turns t
    where t.status in ('queued','ready') and t.available_at <= ${now}
    and not exists(select 1 from public.agent_turns a where a.conversation_id=t.conversation_id and a.status in ('running','sending'))
    order by t.available_at,t.id limit 1 for update skip locked`;
  if (!rows[0]) return null;
  const turn = await tx.agentTurn.findUniqueOrThrow({ where: { id: rows[0].id } });
  return tx.agentTurn.update({ where: { id: turn.id }, data: { status: turn.status === "ready" ? "sending" : "running", claimedAt: now } });
}
export async function expireClaims(tx: Tx, now: Date) {
  const stuck = await tx.agentTurn.findMany({ where: { status: { in: ["running", "sending"] }, claimedAt: { lt: new Date(now.getTime() - 120_000) } }, take: 100 });
  for (const turn of stuck) {
    await tx.agentTurn.update({ where: { id: turn.id }, data: { status: turn.status === "sending" ? "uncertain" : "failed", errorCode: "worker_interrupted" } });
    await pauseConversation(tx, turn, "El procesamiento se interrumpió; revisar antes de continuar.");
  }
  await tx.agentApproval.updateMany({ where: { status: "pending", expiresAt: { lt: now } }, data: { status: "expired" } });
  // Dedup is also anchored in provider_message_id; keep event IDs well beyond Zernio's retry horizon.
  await tx.agentWebhookEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 86400_000) } } });
}
export const pauseConversation = (tx: Tx, scope: Pick<NativeScope, "businessId" | "conversationId">, reason: string) => tx.whatsappConversation.updateMany({
  where: { id: scope.conversationId, businessId: scope.businessId, status: "open" }, data: { status: "handoff", handoffReason: reason }
});
export async function accessForTurn(tx: Tx, scope: NativeScope, accountId: string) {
  const settings = await channelSettings(tx, scope.businessId);
  const integration = await tx.whatsappIntegration.findFirst({ where: { businessId: scope.businessId, providerExternalId: accountId, isActive: true, business: { isActive: true } } });
  const conversation = await tx.whatsappConversation.findFirst({ where: { id: scope.conversationId, businessId: scope.businessId } });
  const latest = await tx.whatsappMessage.findFirst({ where: { businessId: scope.businessId, conversationId: scope.conversationId, direction: "inbound" }, orderBy: [{ createdAt: "desc" }, { receivedAt: "desc" }, { id: "desc" }] });
  const unfinished = await tx.agentAction.count({ where: { businessId: scope.businessId, conversationId: scope.conversationId, status: { in: ["started", "uncertain"] } } });
  const handoffCaseId = await ownHandoff(tx, scope);
  const humanReply = await tx.whatsappMessage.count({ where: { businessId: scope.businessId, conversationId: scope.conversationId, direction: "outbound", receivedAt: { gt: latest?.receivedAt ?? new Date() } } });
  return { settings, integration, conversation, latest, unfinished, handoffCaseId, humanReply };
}
export const scopedTurn = (tx: Tx, businessId: string, id: string) => tx.agentTurn.findFirst({ where: { businessId, id } });

export async function ownHandoff(tx: Tx, scope: NativeScope) {
  const action = await tx.agentAction.findFirst({ where: { businessId: scope.businessId, conversationId: scope.conversationId, messageId: scope.messageId, toolName: "derivar_a_persona", status: "completed" } });
  const result = action?.result as { caso_id?: string; ok?: boolean } | null;
  return result?.ok && result.caso_id ? result.caso_id : null;
}
export async function reserveBudget(tx: Tx, turn: NativeScope, settings: NonNullable<Awaited<ReturnType<typeof channelSettings>>>) {
  await tx.$queryRaw`select id from public.bot_settings where business_id=${turn.businessId}::uuid for update`;
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const budgetDay = since.toISOString().slice(0, 10);
  const used = await tx.agentTurn.count({ where: { businessId: turn.businessId, configuration: { path: ["budgetDay"], equals: budgetDay } } });
  if (used >= settings.dailyTurnLimit) return false;
  await tx.agentTurn.update({ where: { messageId: turn.messageId }, data: { configuration: json({ budgetDay, botName: settings.botName, tone: settings.tone, instructions: settings.instructions,
    businessContext: settings.businessContext, enabledTools: settings.enabledTools, updatedAt: settings.updatedAt }) } });
  return true;
}

export async function skipTurn(tx: Tx, id: string, messageId: string, reason: string) {
  await tx.agentTurn.updateMany({ where: { id, status: { in: ["running", "sending"] } }, data: { status: "skipped", errorCode: reason } });
  await tx.agentApproval.updateMany({ where: { messageId, status: "pending" }, data: { status: "expired" } });
}
export async function failTurn(tx: Tx, turn: NativeScope & { id: string }, code: string, uncertain: boolean) {
  await tx.agentTurn.updateMany({ where: { id: turn.id, status: { in: ["running", "sending"] } }, data: { status: uncertain ? "uncertain" : "failed", errorCode: code } });
  await pauseConversation(tx, turn, "El asistente necesita revisión del equipo antes de continuar.");
  await tx.agentApproval.updateMany({ where: { messageId: turn.messageId, status: "pending" }, data: { status: "expired" } });
}
export const lockDelivery = (tx: Tx, accountId: string, messageId: string) => tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`delivery:${accountId}:${messageId}`}, 0))`;
export async function recordDelivery(tx: Tx, turn: NativeScope & { id: string; reply: string | null; accountId: string }, providerMessageId: string) {
  await lockDelivery(tx, turn.accountId, providerMessageId);
  await tx.whatsappMessage.createMany({ data: [{ businessId: turn.businessId, conversationId: turn.conversationId,
    direction: "outbound", messageType: "text", content: turn.reply, providerMessageId }], skipDuplicates: true });
  const failure = await tx.agentWebhookEvent.findFirst({ where: { AND: [
    { failure: { path: ["accountId"], equals: turn.accountId } }, { failure: { path: ["messageId"], equals: providerMessageId } }
  ] } });
  await tx.agentTurn.updateMany({ where: { id: turn.id, status: "sending" }, data: { status: failure ? "failed" : "sent", providerMessageId, errorCode: failure ? "delivery_failed" : null } });
  if (failure) await pauseConversation(tx, turn, "WhatsApp informó que la respuesta no se entregó.");
}
export const pendingApproval = (tx: Tx, messageId: string) => tx.agentApproval.findFirst({ where: { messageId, status: "pending" } });
export const readyReply = (tx: Tx, id: string, reply: string, buttons: unknown, usage: unknown) => tx.agentTurn.updateMany({ where: { id, status: "running" }, data: {
  status: "ready", reply, ...(buttons ? { buttons: json(buttons) } : {}), usage: json(usage), availableAt: new Date()
} });
