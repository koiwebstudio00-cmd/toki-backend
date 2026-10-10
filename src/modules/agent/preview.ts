import { createHash } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import type { BusinessScope } from "../../lib/request.js";
import { getBotSettings } from "../settings/service.js";
import { buildAgentPrompt } from "./prompt.js";
import { clock } from "./repo.js";
import * as repo from "./preview-repo.js";
import { advancePreviewMemory, readPreviewMemory } from "./preview-memory.js";
import { configuredModel, generateAgentTurn } from "./runtime.js";

const querySchema = z.object({ query: z.string().trim().max(120).describe("Palabra clave breve; vacío para explorar. Si no hay resultados, probá un sinónimo o una palabra más general.") }).strict();

/** Registro cerrado: solo consultas con RLS y negocio fijado por la sesión, sin herramientas de escritura. */
export function previewTools({ ctx, businessId }: BusinessScope, abortSignal?: AbortSignal) {
  let calls = 0;
  const read = async <T>(fn: Parameters<typeof withDb<T>>[1]) => {
    abortSignal?.throwIfAborted();
    if (++calls > 12) throw new ApiError("RATE_LIMITED", "Se alcanzó el límite de consultas de este turno.");
    return withDb(ctx, fn);
  };
  return {
    buscar_productos: tool({ description: "Busca productos disponibles del catálogo actual. Precios base en la moneda del negocio; consultar ver_producto para opciones y recargos.", inputSchema: querySchema,
      execute: async ({ query }) => {
        const rows = await read((tx) => repo.previewProducts(tx, businessId, query));
        return { products: rows.slice(0, 10).map((p) => ({ id: p.id, name: p.name, description: p.description?.slice(0, 2000), price: p.price.toString(), availableStock: p.trackStock ? p.stockQuantity : null })), hasMore: rows.length > 10 };
      }
    }),
    ver_producto: tool({ description: "Consulta un producto disponible por su identificador real, con sus opciones obligatorias y recargos.", inputSchema: z.object({ id: z.string().uuid() }).strict(),
      execute: async ({ id }) => {
        const p = await read((tx) => repo.previewProduct(tx, businessId, id));
        if (!p) return { found: false };
        return { found: true, id: p.id, name: p.name, description: p.description?.slice(0, 2000), price: p.price.toString(), availableStock: p.trackStock ? p.stockQuantity : null,
          optionsTruncated: p.options.length > 20, options: p.options.slice(0, 20).map((o) => ({ ...o, valuesTruncated: o.values.length > 20, values: o.values.slice(0, 20).map((v) => ({ ...v, priceDelta: v.priceDelta.toString() })) })) };
      }
    }),
    buscar_faq: tool({ description: "Busca información vigente en las preguntas frecuentes del negocio. Adaptá la información a la conversación, no copies una respuesta fija.", inputSchema: querySchema,
      execute: async ({ query }) => {
        const rows = await read((tx) => repo.previewFaqs(tx, businessId, query));
        return { faqs: rows.slice(0, 10), hasMore: rows.length > 10 };
      }
    })
  };
}

const pending = new Set<string>();

export async function previewMessage(scope: BusinessScope, input: { message: string; state?: string }, abortSignal?: AbortSignal) {
  if (scope.ctx.role !== "authenticated") throw new ApiError("UNAUTHORIZED", "Sesión requerida.");
  const model = configuredModel();
  const key = `${scope.businessId}:${scope.ctx.userId}`;
  if (pending.has(key)) throw new ApiError("CONFLICT", "Esperá a que termine la respuesta anterior.");
  pending.add(key);
  try {
    const settings = await getBotSettings(scope);
    const revision = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
    const memory = readPreviewMemory(input.state, { businessId: scope.businessId, userId: scope.ctx.userId, revision });
    const context = await withDb(scope.ctx, async (tx) => {
      const business = await repo.previewBusiness(tx, scope.businessId);
      if (!business) throw notFound("El negocio no está disponible.");
      const current = await clock(tx, scope.businessId);
      const schedule = current ? await repo.previewSchedule(tx, scope.businessId, current.now_local.slice(0, 10)) : null;
      return { business, current, schedule };
    });
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(abortSignal ? [abortSignal] : [])]);
    // La pausa de WhatsApp no impide al dueño probar su configuración.
    const instructions = buildAgentPrompt({ ...settings, enabledTools: [], handoffEnabled: false }, context.business.name)
      + `\n\nMODO DE PRUEBA DE CONSULTAS\nEsta conversación prueba tono, instrucciones y conocimiento. Solo podés consultar catálogo y FAQs. No crees ni simules pedidos, pagos, reservas ni derivaciones. Si te piden una operación, explicá que no está disponible en esta prueba. No pidas datos personales para operaciones que no podés realizar.\nConsultá las herramientas para verificar precios, opciones, stock y FAQs vigentes; el historial no es una fuente actualizada. Si hasMore o Truncated es verdadero, no presentes los resultados como exhaustivos.\nDATOS ACTUALES DE TOKI\n${JSON.stringify(context)}`;
    let result: Awaited<ReturnType<typeof generateAgentTurn>>;
    try {
      result = await generateAgentTurn({ model, instructions, messages: [...memory.messages, { role: "user", content: input.message }], tools: previewTools(scope, signal), abortSignal: signal });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // No devolver errores del proveedor: pueden contener prompts o credenciales.
      throw new ApiError("SERVICE_UNAVAILABLE", "No pudimos obtener una respuesta del asistente. Intentá de nuevo.");
    }
    return { ...result, ...advancePreviewMemory(memory, input.message, result.reply) };
  } finally {
    pending.delete(key);
  }
}
