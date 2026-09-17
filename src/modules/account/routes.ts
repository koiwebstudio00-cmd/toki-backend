import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import * as account from "./service.js";

export const accountRoutes = Router();

const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2, "Ingresá tu nombre.").max(120).optional(),
    phone: z
      .string()
      .trim()
      .max(40, "El teléfono es demasiado largo.")
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v))
  })
  .refine((v) => v.fullName !== undefined || v.phone !== undefined, "No hay cambios para guardar.");

accountRoutes.get("/me/profile", requireAuth, async (req, res) => {
  res.json(await account.getProfile(req.auth!.userId, req.auth!.email));
});

accountRoutes.patch("/me/profile", requireAuth, async (req, res) => {
  const input = updateProfileSchema.parse(req.body);
  res.json(await account.updateProfile(req.auth!.userId, req.auth!.email, input));
});
