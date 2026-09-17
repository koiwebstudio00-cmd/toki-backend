// Piezas Zod reutilizables entre módulos.
import { z } from "zod";

export const uuid = (message = "Identificador inválido.") => z.string().uuid(message);

export const idParams = z.object({ id: uuid() });

/** Monto en pesos: número ≥ 0 con hasta 2 decimales (numeric(12,2)). */
export const money = (label = "El monto") =>
  z.coerce
    .number({ invalid_type_error: `${label} tiene que ser un número.` })
    .min(0, `${label} no puede ser negativo.`)
    .max(9_999_999_999.99, `${label} es demasiado alto.`)
    .transform((v) => Math.round(v * 100) / 100);

export const nonNegativeInt = (label = "El valor") =>
  z.coerce
    .number({ invalid_type_error: `${label} tiene que ser un número.` })
    .int(`${label} tiene que ser un número entero.`)
    .min(0, `${label} no puede ser negativo.`)
    .max(2_000_000_000, `${label} es demasiado alto.`);

/** Hora de reloj "HH:mm" (acepta "HH:mm:ss" y lo recorta). */
export const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Usá el formato HH:mm.")
  .transform((v) => v.slice(0, 5));

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Usá el formato AAAA-MM-DD.")
  .refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), "Fecha inválida.");

/** String opcional: "" y solo espacios se guardan como null. */
export const optionalText = (max: number, message = "El texto es demasiado largo.") =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "" || v === null ? null : v));

/** "true"/"false" en query string. */
export const queryBoolean = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();
