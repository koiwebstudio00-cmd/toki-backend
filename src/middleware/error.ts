import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { ApiError } from "../lib/errors.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "El recurso no existe." } });
}

interface PgCause {
  code?: string;
  originalCode?: string;
  message?: string;
  originalMessage?: string;
  kind?: string;
}

/**
 * Error de Postgres que viaja dentro de Prisma con driver adapter. Llega de dos
 * formas: envuelto en PrismaClientKnownRequestError (meta.driverAdapterError) en
 * queries raw, o como DriverAdapterError suelto (con `cause`) en escrituras.
 */
function pgCause(err: unknown): PgCause | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { driverAdapterError?: { cause?: PgCause } } | undefined;
    return meta?.driverAdapterError?.cause;
  }
  if (err instanceof Error && err.name === "DriverAdapterError") {
    return (err as Error & { cause?: PgCause }).cause;
  }
  return undefined;
}

/**
 * Traduce errores de BD a la API:
 * - raise exception de las funciones SQL (P0001): 400 con el mensaje original,
 *   que ya está escrito para el usuario ("La venta no tiene productos").
 * - violación de RLS / permisos (42501): 403.
 * - únicos (P2002 / 23505): 409. Registro inexistente (P2025): 404.
 */
export function mapDbError(err: unknown): ApiError | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return new ApiError("CONFLICT", "Ya existe un registro con esos datos.");
    if (err.code === "P2025") return new ApiError("NOT_FOUND", "El recurso no existe.");
  }

  const cause = pgCause(err);
  const pgCode = cause?.originalCode ?? cause?.code;
  const message = cause?.originalMessage ?? cause?.message;
  if (pgCode === "P0001" && message) return new ApiError("VALIDATION_ERROR", message);
  if (pgCode === "42501") return new ApiError("FORBIDDEN", "No tenés permisos para esta acción.");
  if (pgCode === "23505" || cause?.kind === "UniqueConstraintViolation") {
    return new ApiError("CONFLICT", "Ya existe un registro con esos datos.");
  }
  if (pgCode === "23503") return new ApiError("VALIDATION_ERROR", "Referencia inválida.");
  if (pgCode === "23514") return new ApiError("VALIDATION_ERROR", "Algún dato no cumple las reglas.");
  return null;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Datos inválidos.",
        details: err.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
      }
    });
    return;
  }

  // JSON mal formado en el body.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "JSON inválido." } });
    return;
  }

  const mapped = mapDbError(err);
  if (mapped) {
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }

  // Nunca filtrar detalles internos.
  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Error interno del servidor." } });
}
