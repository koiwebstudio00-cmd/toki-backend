import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";

/**
 * Rate limit por IP. En test no limita (los tests hacen muchos requests desde la
 * misma IP). Detrás de Traefik la IP real sale de X-Forwarded-For (trust proxy 1).
 */
export function limitPerMinute(limit: number): RequestHandler {
  if (config.NODE_ENV === "test") return (_req, _res, next) => next();
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        error: { code: "RATE_LIMITED", message: "Demasiados intentos. Probá en un minuto." }
      })
  });
}

/** login, register, forgot-password, resend-verification. */
export const authLimiter = () => limitPerMinute(5);
/** Checkout y validación de cupón. */
export const publicWriteLimiter = () => limitPerMinute(20);
/** Lecturas públicas (menú, seguimiento). */
export const publicReadLimiter = () => limitPerMinute(120);
