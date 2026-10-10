import type { RequestHandler } from "express";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { BOT_DEFAULTS, type AgentCapability } from "./configuration.js";
import * as repo from "./repo.js";
import { businessQuery } from "./schemas.js";

export function assertCapability(
  settings: { isEnabled: boolean; enabledTools: readonly string[] },
  capability: AgentCapability
) {
  if (!settings.isEnabled) throw new ApiError("FORBIDDEN", "El asistente está pausado.");
  if (!settings.enabledTools.includes(capability)) {
    throw new ApiError("FORBIDDEN", "El negocio no habilitó esta acción para el asistente.");
  }
}

/** Re-read permissions for every call, including old workflow tool routes. */
export async function authorizeCapability(businessId: string, capability: AgentCapability) {
  const settings = await withDb(systemCtx, (tx) => repo.botSettings(tx, businessId));
  assertCapability(settings ?? BOT_DEFAULTS, capability);
}

export function requireCapability(capability: AgentCapability): RequestHandler {
  return async (req, _res, next) => {
    const { businessId } = businessQuery.parse(req.method === "GET" || req.method === "DELETE" ? req.query : req.body);
    await authorizeCapability(businessId, capability);
    next();
  };
}

/** In-flight legacy workflows must stop after a business switches to native. */
export const requireLegacyEngine: RequestHandler = async (req, _res, next) => {
  const body = req.method === "GET" || req.method === "DELETE" ? req.query : req.body;
  if (body && typeof body.businessId === "string") {
    const parsed = businessQuery.safeParse(body);
    if (parsed.success) {
      const native = await withDb(systemCtx, tx => tx.botSettings.findFirst({ where: { businessId: parsed.data.businessId, engine: "native" }, select: { id: true } }));
      if (native) throw new ApiError("CONFLICT", "Este negocio usa el asistente nativo. El flujo anterior debe detenerse.");
    }
  }
  next();
};
