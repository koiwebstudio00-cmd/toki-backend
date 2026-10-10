import type { Tx } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import * as repo from "./channel-repo.js";
export const adminMember = (tx: Tx, businessId: string, userId: string) => tx.businessMember.findFirst({ where: { businessId, userId, role: { in: ["owner", "admin"] } } });
export async function status(tx: Tx, businessId: string) {
  const settings = await repo.channelSettings(tx, businessId);
  const integration = await tx.whatsappIntegration.findUnique({ where: { businessId }, select: { isActive: true, phoneNumber: true, providerExternalId: true } });
  const turns = await tx.agentTurn.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 40,
    select: { id: true, conversationId: true, status: true, errorCode: true, usage: true, createdAt: true, updatedAt: true } });
  return { engine: settings?.engine ?? "legacy", dailyTurnLimit: settings?.dailyTurnLimit ?? 500,
    connected: Boolean(integration?.isActive && integration.providerExternalId), phone: integration?.phoneNumber ?? null, turns };
}
export async function configure(tx: Tx, businessId: string, input: { engine: string; dailyTurnLimit: number }, previousEngine: string) {

    await tx.botSettings.upsert({ where: { businessId: businessId }, create: { businessId: businessId, ...input }, update: input });
    // Switching engines never replays queued messages or approvals from the previous session.
    if (previousEngine !== input.engine) {
      await tx.agentTurn.updateMany({ where: { businessId: businessId, status: { in: ["queued", "ready"] } }, data: { status: "skipped", errorCode: "engine_changed" } });
      await tx.agentApproval.updateMany({ where: { businessId: businessId, status: "pending" }, data: { status: "expired" } });
    }
}
export async function review(tx: Tx, businessId: string, userId: string, id: string, input: { action: "retry" | "reviewed"; note: string }) {

    const turn = await repo.scopedTurn(tx, businessId, id);
    if (!turn) throw notFound("No se encontró ese turno.");
    await tx.$queryRaw`select id from public.whatsapp_conversations where id=${turn.conversationId}::uuid for update`;
    if (!["failed", "uncertain"].includes(turn.status)) throw new ApiError("CONFLICT", "Este turno no necesita revisión.");
    const active = await tx.agentTurn.count({ where: { conversationId: turn.conversationId, status: { in: ["running", "sending"] } } });
    if (active || turn.updatedAt.getTime() > Date.now() - 120_000) throw new ApiError("CONFLICT", "Esperá dos minutos para asegurar que el procesamiento haya terminado.");
    if (input.action === "retry") {
      const writes = await tx.agentAction.count({ where: { conversationId: turn.conversationId, messageId: turn.messageId } });
      const access = await repo.accessForTurn(tx, turn, turn.accountId);
      if (writes || turn.reply || turn.status === "uncertain") throw new ApiError("CONFLICT", "Este turno pudo ejecutar acciones o enviar una respuesta. Revisalo; no se puede repetir automáticamente.");
      if (access.latest?.id !== turn.messageId || access.conversation?.status !== "open") throw new ApiError("CONFLICT", "Retomá el asistente desde la conversación. Solo se puede reintentar el último mensaje.");
      await tx.agentTurn.update({ where: { id }, data: { status: "queued", availableAt: new Date(), errorCode: null, usage: repo.json({ review: input.note, reviewedBy: userId }) } });
    } else {
      // Explicit reconciliation records the operator's finding, never executes the old action.
      await tx.agentAction.updateMany({ where: { businessId: businessId, conversationId: turn.conversationId, status: { in: ["started", "uncertain"] } },
        data: { status: "completed", result: repo.json({ manualReview: true, note: input.note, reviewedBy: userId }), completedAt: new Date() } });
      await tx.agentApproval.updateMany({ where: { businessId: businessId, conversationId: turn.conversationId, status: { in: ["pending", "executing"] } }, data: { status: "failed" } });
      await tx.agentTurn.update({ where: { id }, data: { status: "skipped", errorCode: "operator_reviewed", usage: repo.json({ previousUsage: turn.usage, review: input.note, reviewedBy: userId }) } });
    }
}
