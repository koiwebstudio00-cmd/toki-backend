import type { NextFunction, Request, Response } from "express";
import type { business_role } from "@prisma/client";
import { withDb } from "../lib/db.js";
import { ApiError } from "../lib/errors.js";

export type BusinessRole = business_role;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resuelve el negocio actual y el rol del usuario (va después de requireAuth).
 * - Header opcional `X-Business-Id`: tiene que ser un negocio del que es miembro.
 * - Sin header: el primer negocio del usuario (el front hoy maneja uno solo).
 *
 * La consulta corre como `authenticated`: la policy "members see membership"
 * solo devuelve membresías propias o de negocios propios. Esto es fail-fast;
 * la garantía de aislamiento sigue siendo RLS en cada query del service.
 */
export async function requireBusiness(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) throw new ApiError("UNAUTHORIZED", "Sesión requerida.");
  const { userId, email } = req.auth;

  const requested = req.get("x-business-id");
  if (requested !== undefined && !UUID_RE.test(requested)) {
    throw new ApiError("VALIDATION_ERROR", "X-Business-Id inválido.");
  }

  const membership = await withDb({ role: "authenticated", userId, email }, (tx) =>
    tx.businessMember.findFirst({
      where: { userId, ...(requested ? { businessId: requested } : {}) },
      orderBy: { createdAt: "asc" },
      select: { businessId: true, role: true }
    })
  );

  if (!membership) {
    throw requested
      ? new ApiError("FORBIDDEN", "No tenés acceso a este negocio.")
      : new ApiError("FORBIDDEN", "Todavía no tenés un negocio. Completá el onboarding.");
  }

  req.business = { id: membership.businessId, role: membership.role };
  next();
}

/** Fail-fast de rol (va después de requireBusiness). La garantía real es RLS. */
export function requireRole(...roles: BusinessRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.business) throw new ApiError("FORBIDDEN", "No tenés acceso a este negocio.");
    if (!roles.includes(req.business.role)) {
      throw new ApiError("FORBIDDEN", "Tu rol no permite esta acción.");
    }
    next();
  };
}

/** Atajo: owner o admin (catálogo, configuración). */
export const requireAdmin = requireRole("owner", "admin");
