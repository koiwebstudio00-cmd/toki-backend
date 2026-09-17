import { z } from "zod";
import { money, optionalText } from "../../lib/validation.js";

const code = z
  .string({ required_error: "Ingresá el código." })
  .trim()
  .toUpperCase()
  .min(3, "El código tiene que tener al menos 3 caracteres.")
  .max(30, "El código es demasiado largo.")
  .regex(/^[A-Z0-9-]+$/, "Usá solo letras, números y guiones.");

// Acepta "YYYY-MM-DD" (lo que manda el input date del front) o ISO completo.
const dateTime = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00-03:00` : v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Fecha inválida." });
      return z.NEVER;
    }
    return d;
  });

const fields = {
  code,
  description: optionalText(200),
  discountType: z.enum(["percent", "fixed"], { errorMap: () => ({ message: "Elegí porcentaje o monto fijo." }) }),
  discountValue: money("El descuento").refine((v) => v > 0, "El descuento tiene que ser mayor a cero."),
  minimumOrderAmount: money("El mínimo").optional(),
  startsAt: dateTime,
  endsAt: dateTime,
  usageLimit: z.coerce.number().int().min(1, "El límite tiene que ser al menos 1.").nullable().optional(),
  isActive: z.boolean().optional()
};

type Rules = { discountType?: "percent" | "fixed"; discountValue?: number; startsAt?: Date | null; endsAt?: Date | null };

function rules(v: Rules, ctx: z.RefinementCtx) {
  if (v.discountType === "percent" && v.discountValue !== undefined && v.discountValue > 100) {
    ctx.addIssue({ code: "custom", path: ["discountValue"], message: "El porcentaje no puede superar 100." });
  }
  if (v.startsAt && v.endsAt && v.endsAt < v.startsAt) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "La fecha de fin tiene que ser posterior al inicio." });
  }
}

export const createCouponSchema = z.object(fields).superRefine(rules);

export const updateCouponSchema = z
  .object(fields)
  .partial()
  .superRefine((v, ctx) => {
    if (!Object.values(v).some((x) => x !== undefined)) ctx.addIssue({ code: "custom", message: "No hay cambios para guardar." });
    rules(v, ctx);
  });

export type CreateCouponInput = z.infer<typeof createCouponSchema>;
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;
