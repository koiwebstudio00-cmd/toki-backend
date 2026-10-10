import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { config } from "../src/config.js";
import { audioMessage, configuredModel, generateAgentTurn, modelConfigured } from "../src/modules/agent/runtime.js";

const original = { ...config };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("proveedor del agente", () => {
  beforeEach(() => { Object.assign(config, { OPENAI_API_KEY: "", OPENAI_MODEL: "", AI_GATEWAY_API_KEY: "", AI_GATEWAY_MODEL: "" }); });
  afterEach(() => { Object.assign(config, original); vi.unstubAllGlobals(); });

  it("exige clave y modelo, sin confundir una clave de OpenAI con Gateway", () => {
    expect(modelConfigured()).toBe(false);
    expect(configuredModel).toThrow("todavía no está habilitado");
    config.OPENAI_API_KEY = "fake-openai-key";
    expect(modelConfigured()).toBe(false);
    config.OPENAI_MODEL = "gpt-5.4-mini";
    expect(modelConfigured()).toBe(true);
    expect(configuredModel()).toMatchObject({ provider: "openai.responses", modelId: "gpt-5.4-mini" });
  });

  it("conserva Gateway y prioriza OpenAI sin fallback silencioso ante configuración parcial", () => {
    Object.assign(config, { AI_GATEWAY_API_KEY: "fake-gateway-key", AI_GATEWAY_MODEL: "provider/model" });
    expect(configuredModel()).toBe("provider/model");
    config.OPENAI_MODEL = "gpt-5.4-mini";
    expect(modelConfigured()).toBe(false);
    expect(configuredModel).toThrow();
    config.OPENAI_API_KEY = "fake-openai-key";
    expect(configuredModel()).toMatchObject({ provider: "openai.responses" });
  });

  it("usa Responses con la clave del servidor y conserva schemas opcionales, sin almacenar respuestas", async () => {
    Object.assign(config, { OPENAI_API_KEY: "fake-openai-key", OPENAI_MODEL: "gpt-5.4-mini" });
    const fetch = vi.fn().mockResolvedValue(json({ id: "resp_test", created_at: 1, status: "completed", model: config.OPENAI_MODEL,
      output: [{ type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text: "Tenemos gaseosa.", annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
    vi.stubGlobal("fetch", fetch);
    const result = await generateAgentTurn({ model: configuredModel(), instructions: "Consultá el catálogo.", messages: [{ role: "user", content: "Hola" }], tools: {
      buscar: tool({ inputSchema: z.object({ query: z.string().optional() }), execute: async () => ({ products: [] }) })
    } });
    expect(result.reply).toBe("Tenemos gaseosa.");
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fake-openai-key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "gpt-5.4-mini", store: false, tools: [{ name: "buscar", strict: false }] });
    expect(JSON.stringify(result)).not.toContain("fake-openai-key");
  });

  it("no reintenta ni cambia de proveedor ante un fallo de OpenAI", async () => {
    Object.assign(config, { OPENAI_API_KEY: "fake-openai-key", OPENAI_MODEL: "gpt-5.4-mini", AI_GATEWAY_API_KEY: "fake-gateway-key", AI_GATEWAY_MODEL: "provider/model" });
    const fetch = vi.fn().mockResolvedValue(json({ error: { message: "Unavailable", type: "server_error", code: "server_error" } }, 503));
    vi.stubGlobal("fetch", fetch);
    await expect(generateAgentTurn({ model: configuredModel(), instructions: "Ayudá.", messages: [{ role: "user", content: "Hola" }], tools: {} })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("transcribe una nota de voz de OpenAI como mensaje del cliente", async () => {
    Object.assign(config, { OPENAI_API_KEY: "fake-openai-key", OPENAI_MODEL: "gpt-5.4-mini" });
    const fetch = vi.fn().mockResolvedValue(json({ text: "Una gaseosa para retirar." }));
    vi.stubGlobal("fetch", fetch);
    const audio = new Uint8Array(Buffer.from("OggS-fake-audio"));
    expect(await audioMessage(audio, "audio/ogg")).toEqual({ role: "user", content: "Una gaseosa para retirar." });
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.body as FormData).get("model")).toBe(config.OPENAI_TRANSCRIPTION_MODEL);
    const file = (init.body as FormData).get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  });

  it("rechaza transcripciones vacías y cancelación sin llamar al modelo", async () => {
    Object.assign(config, { OPENAI_API_KEY: "fake-openai-key", OPENAI_MODEL: "gpt-5.4-mini" });
    const fetch = vi.fn().mockResolvedValue(json({ text: " " }));
    vi.stubGlobal("fetch", fetch);
    await expect(audioMessage(new Uint8Array(), "audio/ogg")).rejects.toThrow("nota de voz");
    await expect(audioMessage(new Uint8Array(), "audio/ogg", AbortSignal.abort())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("conserva los bytes de audio para modelos multimodales de Gateway", async () => {
    Object.assign(config, { AI_GATEWAY_API_KEY: "fake-gateway-key", AI_GATEWAY_MODEL: "provider/model" });
    const audio = new Uint8Array([1, 2, 3]);
    expect(await audioMessage(audio, "audio/ogg")).toEqual({ role: "user", content: [{ type: "file", data: audio, mediaType: "audio/ogg" }] });
  });
});
