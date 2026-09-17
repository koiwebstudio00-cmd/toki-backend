import type { Request, Response } from "express";
import morgan from "morgan";
import { config } from "../config.js";

// El health check lo pega Dokploy cada 30 s: si se loguea, tapa todo lo demás.
const SILENCED_PATHS = new Set(["/v1/health"]);

// morgan evalúa `skip` cuando la respuesta termina y Express 5 ya reescribió
// req.url con la ruta relativa al router: hay que comparar contra originalUrl.
export function shouldSkipLog(originalUrl: string): boolean {
  const path = originalUrl.split("?")[0] ?? originalUrl;
  return SILENCED_PATHS.has(path);
}

/**
 * Una línea por request. dev: formato "dev"; producción: "combined"; test: nada.
 * No loguea headers ni body (tokens, API keys, contraseñas). Tampoco query strings
 * del stream de eventos, que llevan el ticket de un solo uso.
 */
export function requestLogger() {
  const format = config.NODE_ENV === "production" ? "combined" : "dev";
  morgan.token("url", (req: Request) => (req.originalUrl ?? req.url).split("?")[0]);
  return morgan<Request, Response>(format, {
    skip: (req) => config.NODE_ENV === "test" || shouldSkipLog(req.originalUrl)
  });
}
