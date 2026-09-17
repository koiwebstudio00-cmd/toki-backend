import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { safeEqualHex, sha256 } from "../lib/tokens.js";

/**
 * Autentica al agente de n8n por `X-Api-Key`. En el servidor solo vive el
 * SHA-256 de la key (AGENT_API_KEY_SHA256); se compara en tiempo constante.
 *
 * La key NO define el negocio: cada tool recibe businessId + conversationId y
 * las funciones SQL validan que la conversación pertenezca a ese negocio.
 */
export function requireApiKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.get("x-api-key");
  if (!key) throw new ApiError("UNAUTHORIZED", "API key requerida.");
  if (!config.AGENT_API_KEY_SHA256 || !safeEqualHex(sha256(key), config.AGENT_API_KEY_SHA256)) {
    throw new ApiError("UNAUTHORIZED", "API key inválida.");
  }
  req.agent = true;
  next();
}
