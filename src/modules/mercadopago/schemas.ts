import { z } from "zod";

export const completeConnectionSchema = z.object({
  state: z.string().regex(/^[a-f0-9]{64}$/),
  code: z.string().min(1).max(2048)
}).strict();

export const connectionSettingsSchema = z.object({
  acceptanceMode: z.enum(["manual", "automatic"])
}).strict();
