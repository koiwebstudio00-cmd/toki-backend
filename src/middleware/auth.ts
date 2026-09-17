import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/tokens.js";

/**
 * Autentica por `Authorization: Bearer <accessToken>`.
 * Deja `req.auth = { userId, email }`. Ver docs/arquitectura.md §4.1.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new ApiError("UNAUTHORIZED", "Sesión requerida.");
  }
  try {
    req.auth = verifyAccessToken(token);
  } catch {
    throw new ApiError("UNAUTHORIZED", "Sesión expirada o inválida.");
  }
  next();
}
