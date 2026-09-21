// docs/api.md §12.
import { z } from "zod";
import { uuid } from "../../lib/validation.js";

export const startConnectSchema = z.object({
  redirectUrl: z
    .string()
    .trim()
    .min(1, "Falta la URL de retorno.")
    .max(500)
    .refine((v) => {
      try {
        return ["http:", "https:"].includes(new URL(v).protocol);
      } catch {
        return false;
      }
    }, "La URL de retorno no es válida."),
  onboarding: z.enum(["business_app", "api"]).default("business_app")
});

export const completeConnectSchema = z.object({
  profileId: z.string().trim().min(1, "Falta el perfil de Zernio.").max(120),
  accountId: z.string().trim().min(1, "Falta la cuenta de WhatsApp.").max(120),
  username: z.string().trim().max(120).nullable().optional(),
  rawQuery: z.record(z.string()).optional()
});

export const listConversationsQuery = z.object({
  status: z.enum(["open", "handoff", "closed"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const listMessagesQuery = z.object({
  before: z.string().datetime({ message: "Fecha inválida." }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const conversationStatusSchema = z.object({
  status: z.enum(["open", "handoff", "closed"], { errorMap: () => ({ message: "Ese estado no existe." }) })
});

export const conversationParams = z.object({ id: uuid("La conversación no existe.") });

export type StartConnectInput = z.infer<typeof startConnectSchema>;
export type CompleteConnectInput = z.infer<typeof completeConnectSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuery>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuery>;
