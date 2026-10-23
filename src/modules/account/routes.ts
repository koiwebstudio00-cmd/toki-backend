import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { IMAGE_CONTENT_TYPES, type ImageContentType } from "../../lib/r2.js";
import * as account from "./service.js";

export const accountRoutes = Router();

const updateProfileSchema = z
  .object({
    avatarUrl: z.string().trim().max(1000).nullable().optional(),
    fullName: z.string().trim().min(2, "Ingresá tu nombre.").max(120).optional(),
    phone: z
      .string()
      .trim()
      .max(40, "El teléfono es demasiado largo.")
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v))
  })
  .refine((v) => v.fullName !== undefined || v.phone !== undefined || v.avatarUrl !== undefined, "No hay cambios para guardar.");

accountRoutes.get("/me/profile", requireAuth, async (req, res) => {
  res.json(await account.getProfile(req.auth!.userId, req.auth!.email));
});

accountRoutes.patch("/me/profile", requireAuth, async (req, res) => {
  const input = updateProfileSchema.parse(req.body);
  res.json(await account.updateProfile(req.auth!.userId, req.auth!.email, input));
});

const avatarUploadSchema = z.object({
  contentType: z.enum(Object.keys(IMAGE_CONTENT_TYPES) as [ImageContentType, ...ImageContentType[]]),
  size: z.number().int().positive().max(2 * 1024 * 1024, "La foto no puede superar los 2 MB.")
});

accountRoutes.post("/me/avatar/presign", requireAuth, async (req, res) => {
  const { contentType, size } = avatarUploadSchema.parse(req.body);
  res.json(await account.presignAvatar(req.auth!.userId, contentType, size));
});
