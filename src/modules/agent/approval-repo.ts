import type { Tx } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { lockConversation, scopeData, type NativeScope } from "./action-repo.js";
import { json } from "./channel-repo.js";
export async function createApproval(tx: Tx, scope: NativeScope, toolName: string, args: unknown, quote: unknown) {
  await lockConversation(tx, scope);
  const existing = await tx.agentApproval.findFirst({ where: { businessId: scope.businessId, conversationId: scope.conversationId, status: { in: ["pending", "executing"] } } });
  if (existing) throw new ApiError("CONFLICT", "Ya hay una confirmación pendiente. Esperá la decisión del cliente.");
  return tx.agentApproval.create({ data: { ...scopeData(scope), toolName, args: json(args), quote: json(quote), expiresAt: new Date(Date.now() + 10 * 60_000) } });
}
export async function claimApproval(tx: Tx, scope: NativeScope, choice: { id: string; approved: boolean } | null) {
  await lockConversation(tx, scope);
  const approval = await tx.agentApproval.findFirst({ where: { businessId: scope.businessId, conversationId: scope.conversationId, status: "pending" } });
  if (!approval) return null;
  const valid = choice?.id === approval.id && approval.expiresAt > new Date();
  await tx.agentApproval.update({ where: { id: approval.id }, data: { status: valid ? (choice.approved ? "executing" : "denied") : "expired" } });
  return valid ? { approval, approved: choice.approved } : null;
}
export const finishApproval = (tx: Tx, id: string, status: "approved" | "failed") => tx.agentApproval.update({ where: { id }, data: { status } });
