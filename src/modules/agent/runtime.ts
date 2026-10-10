import { ToolLoopAgent, isStepCount, transcribe, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { agentModelConnection } from "../../lib/agent-model-config.js";

function openaiProvider() {
  return createOpenAI({ apiKey: config.OPENAI_API_KEY, baseURL: "https://api.openai.com/v1" });
}

export function modelConfigured(): boolean {
  return Boolean(agentModelConnection(config));
}

export function configuredModel(): LanguageModel {
  const connection = agentModelConnection(config);
  if (!connection) throw new ApiError("SERVICE_UNAVAILABLE", "El chat de prueba todavía no está habilitado en este servidor.");
  return connection.provider === "openai" ? openaiProvider().responses(connection.model) : connection.model;
}

/** Responses recibe texto e imágenes; las notas de voz se transcriben primero. */
export async function audioMessage(audio: Uint8Array, mediaType: string, abortSignal?: AbortSignal): Promise<ModelMessage> {
  abortSignal?.throwIfAborted();
  if (agentModelConnection(config)?.provider !== "openai") {
    return { role: "user", content: [{ type: "file", data: audio, mediaType }] };
  }
  const result = await transcribe({
    model: openaiProvider().transcription(config.OPENAI_TRANSCRIPTION_MODEL),
    audio, maxRetries: 0,
    abortSignal: AbortSignal.any([AbortSignal.timeout(20_000), ...(abortSignal ? [abortSignal] : [])])
  });
  if (!result.text.trim() || result.text.length > 16000) throw new ApiError("SERVICE_UNAVAILABLE", "No pudimos interpretar la nota de voz.");
  return { role: "user", content: result.text.trim() };
}

export function createAgent(input: {
  model: LanguageModel;
  instructions: string;
  tools: ToolSet;
}) {
  return new ToolLoopAgent({
    model: input.model,
    instructions: input.instructions,
    tools: input.tools,
    // Toki conserva su propio historial. Los schemas existentes usan campos opcionales.
    ...(typeof input.model !== "string" && input.model.provider === "openai.responses" ? {
      providerOptions: { openai: { store: false, strictJsonSchema: false, reasoningEffort: "low", reasoningSummary: null } }
    } : {}),
    stopWhen: isStepCount(5),
    // Reservar el último paso para responder aunque haya agotado las consultas.
    prepareStep: ({ stepNumber }) => stepNumber >= 4 ? { toolChoice: "none" } : {},
    maxOutputTokens: 1200,
    timeout: 30_000,
    maxRetries: 0
  });
}

/** El canal aporta memoria y herramientas autorizadas; el modelo decide cómo responder. */
export async function generateAgentTurn(input: {
  model: LanguageModel;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  abortSignal?: AbortSignal;
}) {
  const agent = createAgent(input);
  const result = await agent.generate({
    messages: input.messages,
    abortSignal: AbortSignal.any([AbortSignal.timeout(30_000), ...(input.abortSignal ? [input.abortSignal] : [])])
  });
  if (!result.text.trim() || result.finishReason !== "stop") {
    throw new ApiError("SERVICE_UNAVAILABLE", "El asistente no pudo completar la respuesta. Intentá de nuevo.");
  }
  return {
    reply: result.text.trim(),
    toolCalls: [...new Set(result.steps.flatMap((step) => step.toolResults.map((call) => call.toolName)))],
    usage: { inputTokens: result.totalUsage.inputTokens ?? 0, outputTokens: result.totalUsage.outputTokens ?? 0 }
  };
}
