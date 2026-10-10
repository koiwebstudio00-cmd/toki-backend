import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { jwtSecret } from "../../config.js";
import { ApiError } from "../../lib/errors.js";

const key = createHmac("sha256", jwtSecret).update("toki/agent-preview/v1").digest();
const audience = "toki-agent-preview";
export const MAX_PREVIEW_TURNS = 12;
export const previewInput = z.object({ message: z.string().trim().min(1).max(2000), state: z.string().max(100_000).optional() }).strict();
const memorySchema = z.object({
  businessId: z.string().uuid(), userId: z.string().uuid(), revision: z.string(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).max(MAX_PREVIEW_TURNS * 2),
  exp: z.number()
});
type Identity = { businessId: string; userId: string; revision: string };
type Memory = z.infer<typeof memorySchema>;

/** Memoria firmada, vinculada al usuario y al negocio; nunca aceptar roles del navegador. */
export function readPreviewMemory(token: string | undefined, identity: Identity): Memory {
  if (!token) return { ...identity, messages: [], exp: Math.floor(Date.now() / 1000) + 1800 };
  let memory: Memory;
  try {
    memory = memorySchema.parse(jwt.verify(token, key, { algorithms: ["HS256"], audience, issuer: "toki-api" }));
  } catch {
    throw new ApiError("CONFLICT", "La prueba venció o no es válida. Iniciá una nueva conversación.");
  }
  if (memory.businessId !== identity.businessId || memory.userId !== identity.userId) {
    throw new ApiError("FORBIDDEN", "Esta prueba pertenece a otra sesión.");
  }
  if (memory.revision !== identity.revision) throw new ApiError("CONFLICT", "La configuración cambió. Iniciá una nueva conversación para probarla.");
  if (memory.messages.length >= MAX_PREVIEW_TURNS * 2) throw new ApiError("CONFLICT", "Terminó esta prueba. Iniciá una nueva conversación.");
  return memory;
}

export function advancePreviewMemory(memory: Memory, message: string, reply: string) {
  const messages: Memory["messages"] = [...memory.messages, { role: "user", content: message }, { role: "assistant", content: reply }];
  const turns = messages.length / 2;
  const completed = turns >= MAX_PREVIEW_TURNS || Buffer.byteLength(JSON.stringify(messages)) > 48_000;
  return {
    turns, completed,
    state: completed ? null : jwt.sign({ ...memory, messages }, key, { algorithm: "HS256", audience, issuer: "toki-api" })
  };
}
