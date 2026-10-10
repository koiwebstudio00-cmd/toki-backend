import { catalogReference } from "../catalog/message.js";
import type { AgentTurn } from "@prisma/client";
import type { LanguageModel, ModelMessage } from "ai";
import { config } from "../../config.js";
import { systemCtx, withDb } from "../../lib/db.js";
import { zernioFetch, zernioDownload, trustedWhatsappMediaUrl } from "../../lib/zernio.js";
import { createNativeAgent } from "./native-agent.js";
import { audioMessage } from "./runtime.js";
import { requestApproval, consumeApproval, approvalButtons, approvalSummary } from "./approvals.js";
import { saveChannelProof } from "./channel-media.js";
import { inboxEvent } from "./webhook.js";
import * as repo from "./channel-repo.js";

interface WorkerOptions { model?: LanguageModel; now?: Date; signal?: AbortSignal }
function canRun(access: Awaited<ReturnType<typeof repo.accessForTurn>>, turn: AgentTurn, now: Date, allowOwnHandoff = false) {
  return access.settings?.engine === "native" && access.settings.isEnabled && access.integration &&
    !access.unfinished && (access.conversation?.status === "open" || (allowOwnHandoff && access.conversation?.status === "handoff" &&
      access.handoffCaseId && access.conversation.currentCaseId === access.handoffCaseId && !access.humanReply)) && access.latest?.id === turn.messageId &&
    now.getTime() - access.latest.createdAt.getTime() < 23.9 * 3600_000;
}
async function skip(turn: AgentTurn, reason: string) {
  await withDb(systemCtx, tx => repo.skipTurn(tx, turn.id, turn.messageId, reason));
}
async function fail(turn: AgentTurn, code: string, uncertain = false) {
  await withDb(systemCtx, tx => repo.failTurn(tx, turn, code, uncertain));
}

async function deliver(turn: AgentTurn, options: WorkerOptions) {
  const access = await withDb(systemCtx, tx => repo.accessForTurn(tx, turn, turn.accountId));
  if (access.unfinished) { await fail(turn, "action_review_required"); return; }
  if (!canRun(access, turn, options.now ?? new Date(), true)) { await skip(turn, "conversation_changed"); return; }
  if (!turn.reply) { await fail(turn, "empty_reply"); return; }
  options.signal?.throwIfAborted();
  try {
    const result = await zernioFetch<{ success: boolean; data?: { messageId?: string; partialFailure?: unknown } }>(
      `/inbox/conversations/${encodeURIComponent(turn.providerConversationId)}/messages`, {
        method: "POST", idempotencyKey: turn.id,
        body: { accountId: turn.accountId, message: turn.reply, ...(Array.isArray(turn.buttons) ? { buttons: turn.buttons } : {}) }
      });
    if (!result.success || !result.data?.messageId || result.data.partialFailure) throw new Error("Unknown delivery");
    await withDb(systemCtx, tx => repo.recordDelivery(tx, turn, result.data!.messageId!));
  } catch {
    // Zernio does not guarantee idempotency after an ambiguous 5xx; never resend blindly.
    await fail(turn, "delivery_unknown", true);
  }
}

async function generate(turn: AgentTurn, options: WorkerOptions) {
  const access = await withDb(systemCtx, tx => repo.accessForTurn(tx, turn, turn.accountId));
  if (access.unfinished) { await fail(turn, "action_review_required"); return; }
  if (!canRun(access, turn, options.now ?? new Date())) { await skip(turn, "conversation_changed"); return; }
  const quota = await withDb(systemCtx, tx => repo.reserveBudget(tx, turn, access.settings!));
  if (!quota) { await fail(turn, "daily_limit"); return; }
  const event = inboxEvent.safeParse(access.latest!.rawPayload);
  const outcome = await consumeApproval(turn, event.success && event.data.metadata?.interactiveType === "button_reply" ? event.data.metadata.interactiveId : undefined);
  const history = await withDb(systemCtx, tx => repo.messageHistory(tx, turn));
  // A checkout request can be followed by a short message in the same burst.
  // Offer only the most recent reference since the last outbound reply.
  const outboundIndex = history.findIndex(m => m.direction === "outbound");
  const unanswered = outboundIndex < 0 ? history : history.slice(0, outboundIndex);
  const catalogMessage = unanswered.find(m => m.direction === "inbound" && m.messageType === "text" && catalogReference(m.content ?? ""));
  const messages: ModelMessage[] = history.reverse().map(m => ({ role: m.direction === "inbound" ? "user" as const : "assistant" as const,
    content: (m.content || `[Adjunto recibido: ${m.messageType}]`).slice(0, 4000) }));
  // Only the current, verified channel attachment is sent as bytes. The model never fetches URLs.
  const attachment = event.success ? event.data.message.attachments[0] : undefined;
  if (attachment && ["image", "audio"].includes(attachment.type)) {
    const media = await zernioDownload(trustedWhatsappMediaUrl(attachment.url, turn.accountId), 5 * 1024 * 1024);
    const type = media.contentType.split(";")[0]!.trim();
    if (attachment.type === "image" && ["image/jpeg", "image/png", "image/webp"].includes(type)) {
      messages[messages.length - 1] = { role: "user", content: [{ type: "text", text: access.latest!.content || "Te envío esta imagen." }, { type: "image", image: media.body, mediaType: type }] };
    } else if (attachment.type === "audio" && type.startsWith("audio/")) {
      messages[messages.length - 1] = await audioMessage(media.body, type, options.signal);
    } else throw new Error("Unsupported media");
  }
  const deadline = AbortSignal.any([AbortSignal.timeout(50_000), ...(options.signal ? [options.signal] : [])]);
  const agent = await createNativeAgent(turn, { model: options.model, abortSignal: deadline, outcome,
    channel: { catalogMessageId: catalogMessage?.id, requestApproval: (name, args) => requestApproval(turn, name, args), paymentProof: code => saveChannelProof(turn, turn.accountId, code) } });
  const result = await agent.generate({ messages, abortSignal: deadline });
  const pending = await withDb(systemCtx, tx => repo.pendingApproval(tx, turn.messageId));
  let reply = result.text.trim();
  if (pending) reply = `${reply}\n\n${approvalSummary(pending.quote)}`.trim();
  if (!reply || result.finishReason !== "stop" || reply.length > (pending ? 1024 : 4096)) throw new Error("Incomplete response");
  // Recheck after model/tool work: takeover, pause, reconnect and newer messages win.
  const fresh = await withDb(systemCtx, tx => repo.accessForTurn(tx, turn, turn.accountId));
  if (fresh.unfinished) { await fail(turn, "action_review_required"); return; }
  if (!canRun(fresh, turn, new Date(), true)) { await skip(turn, "conversation_changed"); return; }
  await withDb(systemCtx, tx => repo.readyReply(tx, turn.id, reply, pending ? approvalButtons(pending.id) : null, {
    inputTokens: result.totalUsage.inputTokens ?? 0, outputTokens: result.totalUsage.outputTokens ?? 0,
    tools: result.steps.flatMap(s => s.toolResults.map(t => t.toolName))
  }));
}

/** One durable unit; public for deterministic integration tests and a standalone worker. */
export async function processNextAgentTurn(options: WorkerOptions = {}) {
  const turn = await withDb(systemCtx, tx => repo.claimTurn(tx, options.now ?? new Date()));
  if (!turn) return false;
  try {
    if (turn.status === "sending") await deliver(turn, options);
    else await generate(turn, options);
  } catch { await fail(turn, "processing_failed", turn.status === "sending"); }
  return true;
}
export async function recoverInterruptedTurns(now = new Date()) {
  await withDb(systemCtx, tx => repo.expireClaims(tx, now));
}
export function startAgentWorker() {
  if (!config.AGENT_WORKER_ENABLED) return async () => {};
  const controller = new AbortController();
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const active = new Set<Promise<void>>();
  let maintenanceAt = 0;
  const tick = async () => {
    try {
      if (Date.now() - maintenanceAt > 60_000) { maintenanceAt = Date.now(); await recoverInterruptedTurns(); }
      await processNextAgentTurn({ signal: controller.signal });
    } catch { console.error("[agent-worker] No se pudo procesar la cola; se reintentará la consulta."); }
    if (!stopped) {
      const timer = setTimeout(() => { timers.delete(timer); launch(); }, 1000);
      timers.add(timer);
    }
  };
  const launch = () => { const task = tick(); active.add(task); void task.finally(() => active.delete(task)); };
  for (let i = 0; i < config.AGENT_WORKER_CONCURRENCY; i++) launch();
  return async () => { stopped = true; for (const timer of timers) clearTimeout(timer); controller.abort(); await Promise.allSettled(active); };
}
