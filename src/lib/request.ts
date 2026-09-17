import type { Request } from "express";
import type { DbCtx } from "./db.js";
import { ApiError } from "./errors.js";

/** Contexto de BD del usuario autenticado (requireAuth). */
export function userCtx(req: Request): DbCtx {
  if (!req.auth) throw new ApiError("UNAUTHORIZED", "Sesión requerida.");
  return { role: "authenticated", userId: req.auth.userId, email: req.auth.email };
}

/**
 * Contexto + negocio actual (requireBusiness). Los services filtran SIEMPRE por
 * este businessId además de RLS: un usuario con dos negocios pasa RLS en ambos,
 * y lo que corresponde es operar solo sobre el negocio elegido.
 */
export function businessScope(req: Request): { ctx: DbCtx; businessId: string } {
  if (!req.business) throw new ApiError("FORBIDDEN", "No tenés acceso a este negocio.");
  return { ctx: userCtx(req), businessId: req.business.id };
}

export type BusinessScope = ReturnType<typeof businessScope>;
