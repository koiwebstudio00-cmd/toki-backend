// Casos (derivaciones) y reembolsos del panel — agente v3, docs/api.md §15.
import { z } from "zod";

export const resolveCaseSchema = z.object({
  note: z.string().trim().max(500, "La nota es demasiado larga.").nullable().optional()
});

export const listRefundsQuery = z.object({
  status: z.enum(["pending", "completed", "rejected"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const REFUND_PROOF_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf"
} as const;

export const refundProofUploadSchema = z.object({
  contentType: z.enum(Object.keys(REFUND_PROOF_TYPES) as [keyof typeof REFUND_PROOF_TYPES, ...(keyof typeof REFUND_PROOF_TYPES)[]], {
    errorMap: () => ({ message: "Formato no permitido. Subí una imagen (JPG, PNG, WebP) o un PDF." })
  })
});

export const completeRefundSchema = z.object({
  proofKey: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(500, "La nota es demasiado larga.").nullable().optional()
});

export const rejectRefundSchema = z.object({
  notes: z.string().trim().min(3, "Contá por qué no se devuelve.").max(500, "La nota es demasiado larga.")
});

export type ListRefundsQuery = z.infer<typeof listRefundsQuery>;
export type CompleteRefundInput = z.infer<typeof completeRefundSchema>;
