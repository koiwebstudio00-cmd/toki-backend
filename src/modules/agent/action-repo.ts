import type { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/db.js";
import { botSettingsSelect } from "./configuration.js";

export interface NativeScope { businessId: string; conversationId: string; messageId: string }

export const scopeData = (scope: NativeScope): NativeScope => ({ businessId: scope.businessId, conversationId: scope.conversationId, messageId: scope.messageId });

export async function lockConversation(tx: Tx, scope: NativeScope) {
  // Short transaction only: never hold this row lock during a model/tool call.
  await tx.$queryRaw`select id from public.whatsapp_conversations where id = ${scope.conversationId}::uuid and business_id = ${scope.businessId}::uuid for update`;
}

export async function nativeAccess(tx: Tx, scope: NativeScope) {
  const conversation = await tx.whatsappConversation.findFirst({ where: { id: scope.conversationId, businessId: scope.businessId },
    select: { status: true, business: { select: { isActive: true, botSettings: { select: { ...botSettingsSelect, engine: true } } } } } });
  const message = await tx.whatsappMessage.findFirst({ where: { id: scope.messageId, businessId: scope.businessId, conversationId: scope.conversationId, direction: "inbound" }, select: { id: true, createdAt: true } });
  const latest = await tx.whatsappMessage.findFirst({ where: { businessId: scope.businessId, conversationId: scope.conversationId, direction: "inbound" }, orderBy: [{ createdAt: "desc" }, { receivedAt: "desc" }, { id: "desc" }], select: { id: true } });
  const channelTurn = await tx.agentTurn.findUnique({ where: { messageId: scope.messageId }, select: { accountId: true } });
  const channelActive = !channelTurn || Boolean(await tx.whatsappIntegration.findFirst({ where: { businessId: scope.businessId, providerExternalId: channelTurn.accountId, isActive: true } }));
  return { conversation, message, latest, channelTurn, channelActive };
}

export const findAction = (tx: Tx, scope: NativeScope, toolName: string, inputHash: string) =>
  tx.agentAction.findFirst({ where: { ...scopeData(scope), toolName, inputHash } });

export const unfinishedAction = (tx: Tx, scope: NativeScope) =>
  tx.agentAction.findFirst({ where: { businessId: scope.businessId, conversationId: scope.conversationId, status: { in: ["started", "uncertain"] } }, select: { id: true } });

export const startAction = (tx: Tx, scope: NativeScope, toolName: string, inputHash: string) =>
  tx.agentAction.create({ data: { ...scopeData(scope), toolName, inputHash }, select: { id: true } });

export const completeAction = (tx: Tx, scope: NativeScope, id: string, result: Prisma.InputJsonValue) =>
  tx.agentAction.updateMany({ where: { ...scopeData(scope), id, status: "started" }, data: { status: "completed", result, completedAt: new Date() } });

export const uncertainAction = (tx: Tx, scope: NativeScope, id: string) =>
  tx.agentAction.updateMany({ where: { ...scopeData(scope), id, status: "started" }, data: { status: "uncertain" } });
