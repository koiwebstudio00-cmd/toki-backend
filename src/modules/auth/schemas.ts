import { z } from "zod";

export const emailSchema = z
  .string({ required_error: "Ingresá tu email." })
  .trim()
  .toLowerCase()
  .email("Ingresá un email válido.")
  .max(254);

// bcrypt solo usa los primeros 72 bytes: más largo sería una falsa sensación de seguridad.
export const passwordSchema = z
  .string({ required_error: "Ingresá una contraseña." })
  .min(8, "La contraseña tiene que tener al menos 8 caracteres.")
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72, "La contraseña es demasiado larga.");

const tokenSchema = z.string({ required_error: "Falta el token." }).trim().min(1, "Falta el token.").max(200);

export const registerSchema = z.object({
  fullName: z.string({ required_error: "Ingresá tu nombre." }).trim().min(2, "Ingresá tu nombre.").max(120),
  email: emailSchema,
  password: passwordSchema
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ required_error: "Ingresá tu contraseña." }).min(1, "Ingresá tu contraseña.").max(200)
});

export const emailOnlySchema = z.object({ email: emailSchema });
export const tokenOnlySchema = z.object({ token: tokenSchema });
export const refreshSchema = z.object({ refreshToken: tokenSchema });
export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });
export const logoutSchema = z.object({
  refreshToken: tokenSchema.optional(),
  all: z.boolean().optional()
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
