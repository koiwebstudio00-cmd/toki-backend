import { z } from "zod";
import { nonNegativeInt, optionalText } from "../../lib/validation.js";

export const paymentSettingsSchema = z
  .object({
    cashEnabled: z.boolean(),
    transferEnabled: z.boolean(),
    transferCbu: z
      .string()
      .trim()
      .regex(/^(\d{6,22})?$/, "Ingresá solo números, entre 6 y 22 dígitos.")
      .nullable()
      .optional()
      .transform((v) => v || null),
    transferAlias: optionalText(40, "Usá un alias más corto."),
    transferHolder: optionalText(80, "Usá un titular más corto."),
    transferBank: optionalText(80, "Usá un nombre más corto."),
    // Mercado Pago está modelado pero no integrado: se rechaza habilitarlo.
    mercadopagoEnabled: z.literal(false, { errorMap: () => ({ message: "Mercado Pago todavía no está disponible." }) }).optional()
  })
  .superRefine((v, ctx) => {
    if (!v.cashEnabled && !v.transferEnabled) {
      ctx.addIssue({ code: "custom", path: ["cashEnabled"], message: "Activá al menos un medio de pago." });
    }
    if (v.transferEnabled && !v.transferCbu) {
      ctx.addIssue({ code: "custom", path: ["transferCbu"], message: "Cargá tu CBU/CVU para usar transferencia." });
    }
  });

export const loyaltySettingsSchema = z.object({
  isEnabled: z.boolean(),
  pointsPerCurrency: z.coerce.number().min(0, "No puede ser negativo.").max(1000),
  pointsPerOrder: nonNegativeInt("Los puntos por pedido"),
  redeemRate: z.coerce.number().gt(0, "Tiene que ser mayor a cero.").max(1_000_000),
  minPointsToRedeem: nonNegativeInt("El mínimo de puntos")
});

export const botSettingsSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    botName: z.string().trim().min(1, "Ingresá un nombre.").max(40).optional(),
    tone: z.string().trim().min(1).max(40).optional(),
    fallbackMessage: z.string().trim().min(1, "Ingresá el mensaje.").max(500).optional(),
    handoffEnabled: z.boolean().optional()
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "No hay cambios para guardar.");

export const createFaqSchema = z.object({
  question: z.string().trim().min(3, "Escribí la pregunta.").max(300),
  answer: z.string().trim().min(1, "Escribí la respuesta.").max(1500),
  isActive: z.boolean().optional()
});

export const updateFaqSchema = createFaqSchema
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "No hay cambios para guardar.");

export type PaymentSettingsInput = z.infer<typeof paymentSettingsSchema>;
export type LoyaltySettingsInput = z.infer<typeof loyaltySettingsSchema>;
export type BotSettingsInput = z.infer<typeof botSettingsSchema>;
export type CreateFaqInput = z.infer<typeof createFaqSchema>;
export type UpdateFaqInput = z.infer<typeof updateFaqSchema>;
