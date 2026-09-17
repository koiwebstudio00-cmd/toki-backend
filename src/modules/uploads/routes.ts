import { Router } from "express";
import { z } from "zod";
import { IMAGE_CONTENT_TYPES, type ImageContentType, newImageKey, PRESIGN_TTL_SECONDS, presignPut, publicUrl } from "../../lib/r2.js";
import { businessScope } from "../../lib/request.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireAdmin, requireBusiness } from "../../middleware/business.js";

/**
 * /v1/uploads — URLs prefirmadas para subir imágenes directo a R2 (docs/arquitectura.md §7).
 * El navegador hace PUT con el mismo Content-Type y después guarda `publicUrl`
 * en el producto, la categoría o el negocio. La key la arma el backend: el
 * cliente nunca elige la ruta ni el negocio.
 */
export const uploadRoutes = Router();
uploadRoutes.use(requireAuth, requireBusiness);

const presignSchema = z.object({
  kind: z.enum(["product", "category", "business-logo", "business-cover"], {
    errorMap: () => ({ message: "Tipo de imagen inválido." })
  }),
  contentType: z.enum(Object.keys(IMAGE_CONTENT_TYPES) as [ImageContentType, ...ImageContentType[]], {
    errorMap: () => ({ message: "Formato no permitido. Usá WebP, JPG o PNG." })
  })
});

uploadRoutes.post("/presign", requireAdmin, async (req, res) => {
  const { kind, contentType } = presignSchema.parse(req.body);
  const { businessId } = businessScope(req);
  const key = newImageKey(businessId, kind, contentType);
  res.json({
    uploadUrl: await presignPut("public", key, contentType),
    method: "PUT",
    headers: { "Content-Type": contentType },
    key,
    publicUrl: publicUrl(key),
    expiresIn: PRESIGN_TTL_SECONDS
  });
});
