import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { systemCtx, withDb, type Tx } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { BOT_DEFAULTS, type AgentCapability } from "./configuration.js";
import * as repo from "./action-repo.js";
import { assertCapability } from "./permissions.js";

export type NativePermission = AgentCapability | "handoff" | "read";
export type { NativeScope } from "./action-repo.js";

async function authorize(tx: Tx, scope: repo.NativeScope, permission: NativePermission) {
  const { conversation, message, latest, channelTurn, channelActive } = await repo.nativeAccess(tx, scope);
  if (!conversation || !message) throw notFound("La conversación o el mensaje no existen en este negocio.");
  if (!conversation.business.isActive) throw new ApiError("FORBIDDEN", "El negocio está inactivo.");
  if (channelTurn && (!channelActive || conversation.business.botSettings?.engine !== "native")) throw new ApiError("FORBIDDEN", "El canal del asistente cambió o se desconectó.");
  const settings = conversation.business.botSettings ?? BOT_DEFAULTS;
  if (!settings.isEnabled) throw new ApiError("FORBIDDEN", "El asistente está pausado.");
  if (permission === "handoff" && !settings.handoffEnabled) throw new ApiError("FORBIDDEN", "La derivación está deshabilitada.");
  if (permission !== "handoff" && permission !== "read") assertCapability(settings, permission);
  if (latest?.id !== message.id) throw new ApiError("CONFLICT", "Llegó otro mensaje del cliente. Este turno quedó desactualizado.");
  return { status: conversation.status, settings };
}

const reviewRequired = () => new ApiError("CONFLICT", "Hay una acción pendiente de revisión. No repitas operaciones ni afirmes que se completaron.");

export async function authorizeNativeRead(scope: repo.NativeScope, permission: NativePermission = "read") {
  return withDb(systemCtx, async (tx) => {
    const access = await authorize(tx, scope, permission);
    if (access.status !== "open") throw new ApiError("FORBIDDEN", "La conversación está cerrada o en atención humana.");
    if (await repo.unfinishedAction(tx, scope)) throw reviewRequired();
    return access.settings;
  });
}

/** Ordenar claves: dos reintentos con el mismo JSON deben tener la misma identidad. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * At-most-once attempt for an inbound/tool/arguments identity. The receipt and
 * legacy business services use separate transactions; an interrupted operation
 * therefore stays blocked for reconciliation, never silently retried.
 */
export async function executeNativeAction(input: {
  scope: repo.NativeScope; permission: NativePermission; toolName: string; args: unknown;
  execute: () => Promise<unknown>; abortSignal?: AbortSignal;
}): Promise<unknown> {
  input.abortSignal?.throwIfAborted();
  const hash = createHash("sha256").update(canonical(input.args)).digest("hex");
  const claim = await withDb(systemCtx, async (tx) => {
    await repo.lockConversation(tx, input.scope);
    const access = await authorize(tx, input.scope, input.permission);
    if (await repo.unfinishedAction(tx, input.scope)) throw reviewRequired();
    const existing = await repo.findAction(tx, input.scope, input.toolName, hash);
    if (existing?.status === "completed") return { replay: true as const, result: existing.result };
    if (access.status !== "open") throw new ApiError("FORBIDDEN", "La conversación está cerrada o en atención humana.");
    input.abortSignal?.throwIfAborted();
    const action = await repo.startAction(tx, input.scope, input.toolName, hash);
    return { replay: false as const, id: action.id };
  });
  if (claim.replay) return claim.result;
  try {
    input.abortSignal?.throwIfAborted();
    // Do not abort between business commit and receipt: always save its outcome.
    const result = JSON.parse(JSON.stringify(await input.execute())) as Prisma.InputJsonValue;
    if (result === null) throw new Error("Missing action result");
    const completed = await withDb(systemCtx, (tx) => repo.completeAction(tx, input.scope, claim.id, result));
    if (completed.count !== 1) throw new Error("Action receipt missing");
    return result;
  } catch {
    // If even this update fails, 'started' also blocks future execution.
    await withDb(systemCtx, (tx) => repo.uncertainAction(tx, input.scope, claim.id)).catch(() => undefined);
    throw reviewRequired();
  }
}
