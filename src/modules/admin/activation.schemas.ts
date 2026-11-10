import { z } from "zod";
import { passwordSchema } from "../auth/schemas.js";
export const adminToken = z.string().trim().regex(/^[a-f0-9]{64}$/i, "El enlace de activación no es válido.");
export const activationCheckInput = z.object({ token: adminToken });
export const activationStartInput = activationCheckInput.extend({
  fullName: z.string().trim().min(2, "Ingresá tu nombre.").max(120),
  password: passwordSchema
});
export const activationConfirmInput = z.object({
  setupToken: adminToken,
  code: z.string().trim().regex(/^\d{6}$/, "Ingresá el código de seis dígitos.")
});
