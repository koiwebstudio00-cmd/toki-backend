import { z } from "zod";
import { config } from "../../config.js";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import type { BusinessScope } from "../../lib/request.js";
import { modelConfigured } from "./runtime.js";
import * as adminRepo from "./channel-admin-repo.js";

export const channelConfigSchema = z.object({ engine: z.enum(["legacy", "native"]), dailyTurnLimit: z.number().int().min(1).max(10000) }).strict();
export const reviewSchema = z.object({ action: z.enum(["retry", "reviewed"]), note: z.string().trim().min(10).max(500) }).strict();
async function authorize(scope: BusinessScope) {
  if (scope.ctx.role !== "authenticated") throw new ApiError("FORBIDDEN", "Sesión requerida.");
  const userId = scope.ctx.userId;
  const member = await withDb(scope.ctx, tx => adminRepo.adminMember(tx, scope.businessId, userId));
  if (!member) throw new ApiError("FORBIDDEN", "Tu rol no permite administrar el asistente.");
  return userId;
}
export async function channelStatus(scope: BusinessScope) {
  await authorize(scope);
  const state = await withDb(systemCtx, tx => adminRepo.status(tx, scope.businessId));
  return { ...state, ready: modelConfigured() && Boolean(config.ZERNIO_API_KEY && config.ZERNIO_WEBHOOK_SECRET && config.AGENT_WORKER_ENABLED) };
}
export async function configureChannel(scope: BusinessScope, input: z.infer<typeof channelConfigSchema>) {
  await authorize(scope);
  const status = await channelStatus(scope);
  if (input.engine === "native" && (!status.ready || !status.connected)) throw new ApiError("CONFLICT", "Primero hay que completar la conexión del asistente y de WhatsApp.");
  await withDb(systemCtx, tx => adminRepo.configure(tx, scope.businessId, input, status.engine));
  return channelStatus(scope);
}
export async function reviewTurn(scope: BusinessScope, id: string, input: z.infer<typeof reviewSchema>) {
  const userId = await authorize(scope);
  await withDb(systemCtx, tx => adminRepo.review(tx, scope.businessId, userId, id, input));
  return channelStatus(scope);
}
