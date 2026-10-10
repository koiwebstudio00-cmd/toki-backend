import { MockLanguageModelV4 } from "ai/test";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { type ToolSet } from "ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, withDb, systemCtx } from "../src/lib/db.js";
import { createNativeTools } from "../src/modules/agent/native-tools.js";
import { createNativeAgent } from "../src/modules/agent/native-agent.js";
import { executeNativeAction, type NativeScope } from "../src/modules/agent/actions.js";
import { DB_AVAILABLE, ownerDb, seedShop, createUser, createBusiness, authCtx, TEST_AGENT_KEY } from "./helpers.js";

const invoke = async (tools: ToolSet, name: string, args: unknown = {}) => tools[name]!.execute!(args, { toolCallId: "test-call", messages: [], context: {} });
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const call = (toolName: string, input: object) => ({ content: [{ type: "tool-call" as const, toolCallId: "call-1", toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] });
const answer = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });

describe.runIf(DB_AVAILABLE)("herramientas operativas del motor nativo", () => {
  let shop: Awaited<ReturnType<typeof seedShop>>;
  let scope: NativeScope;
  beforeEach(async () => {
    shop = await seedShop();
    const conversation = await ownerDb().whatsappConversation.create({ data: { businessId: shop.businessId, contactId: "native-client", phone: "3815550000" } });
    const message = await ownerDb().whatsappMessage.create({ data: { businessId: shop.businessId, conversationId: conversation.id, direction: "inbound", content: "Quiero una gaseosa." } });
    scope = { businessId: shop.businessId, conversationId: conversation.id, messageId: message.id };
  });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });

  it("el modelo arma un borrador con precios de Toki y el reintento no duplica productos", async () => {
    const input = { items: [{ productId: shop.sodaId, quantity: 1, optionValueIds: [] }] };
    const model = new MockLanguageModelV4({ doGenerate: [call("agregar_productos", input), answer("Agregué la gaseosa al borrador. ¿Lo retirás o necesitás envío?")] });
    const agent = await createNativeAgent(scope, { model });
    const result = await agent.generate({ prompt: "Quiero una gaseosa" });
    expect(result.text).toContain("borrador");
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("2500");
    const first = await ownerDb().whatsappOrderDraftItem.findFirstOrThrow({ where: { businessId: shop.businessId } });
    expect(first.quantity).toBe(1); expect(Number(first.totalPrice)).toBe(2500);
    // A new registry represents another process/retry; dedup must not live in memory.
    const restarted = await createNativeTools(scope);
    await invoke(restarted, "agregar_productos", input);
    expect((await ownerDb().whatsappOrderDraftItem.findUniqueOrThrow({ where: { id: first.id } })).quantity).toBe(1);
    expect(await ownerDb().agentAction.count()).toBe(1);
    expect(await ownerDb().order.count()).toBe(0);
  });

  it("revocar un permiso, pausar el bot o tomar la conversación bloquea herramientas ya creadas", async () => {
    const tools = await createNativeTools(scope);
    await ownerDb().botSettings.update({ where: { businessId: shop.businessId }, data: { enabledTools: [] } });
    await expect(invoke(tools, "agregar_productos", { items: [{ productId: shop.sodaId, quantity: 1, optionValueIds: [] }] })).rejects.toThrow("no habilitó");
    expect(Object.keys(await createNativeTools(scope))).not.toContain("agregar_productos");
    await ownerDb().botSettings.update({ where: { businessId: shop.businessId }, data: { isEnabled: false } });
    await expect(invoke(tools, "buscar_productos", { query: "gaseosa" })).rejects.toThrow("pausado");
    await ownerDb().botSettings.update({ where: { businessId: shop.businessId }, data: { isEnabled: true } });
    await ownerDb().whatsappConversation.update({ where: { id: scope.conversationId }, data: { status: "handoff" } });
    await expect(invoke(tools, "buscar_productos", { query: "" })).rejects.toThrow("atención humana");
    expect(await ownerDb().agentAction.count()).toBe(0);
  });

  it("rechaza otro negocio, otro contacto y mensajes salientes como identidad del turno", async () => {
    const other = await createUser("native-other@test.com");
    const otherBusiness = await createBusiness(other, "native-other");
    await expect(createNativeTools({ ...scope, businessId: otherBusiness })).rejects.toThrow("no existen");
    const conversation = await ownerDb().whatsappConversation.create({ data: { businessId: shop.businessId, contactId: "another-client" } });
    await expect(createNativeTools({ ...scope, conversationId: conversation.id })).rejects.toThrow("no existen");
    const outgoing = await ownerDb().whatsappMessage.create({ data: { businessId: shop.businessId, conversationId: scope.conversationId, direction: "outbound", content: "Hola" } });
    await expect(createNativeTools({ ...scope, messageId: outgoing.id })).rejects.toThrow("no existen");
    await expect(withDb(systemCtx, (tx) => tx.agentAction.create({ data: { ...scope, businessId: otherBusiness, toolName: "forged", inputHash: "x" } }))).rejects.toThrow();
    await expect(withDb(authCtx(shop.owner), (tx) => tx.agentAction.findMany())).rejects.toThrow();
  });

  it("un mensaje nuevo invalida las herramientas del turno anterior", async () => {
    const tools = await createNativeTools(scope);
    await ownerDb().whatsappMessage.create({ data: { businessId: shop.businessId, conversationId: scope.conversationId, direction: "inbound", content: "No, mejor no", createdAt: new Date(Date.now() + 1000) } });
    await expect(invoke(tools, "agregar_productos", { items: [{ productId: shop.sodaId, quantity: 1, optionValueIds: [] }] })).rejects.toThrow("desactualizado");
    expect(await ownerDb().whatsappOrderDraftItem.count()).toBe(0);
  });

  it("un código conocido no permite consultar el pedido de otro cliente", async () => {
    const otherConversation = await ownerDb().whatsappConversation.create({ data: { businessId: shop.businessId, contactId: "private-customer", phone: "3815559999" } });
    await ownerDb().order.create({ data: { businessId: shop.businessId, whatsappConversationId: otherConversation.id, orderCode: "TK-999123", orderType: "takeaway", customerName: "CLIENTE PRIVADO", customerPhone: "3815559999", subtotal: 2500, total: 2500 } });
    const result = await invoke(await createNativeTools(scope), "consultar_pedido", { orderCode: "TK-999123" });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("CLIENTE PRIVADO");
    const app = buildApp();
    const key = { "x-api-key": TEST_AGENT_KEY };
    const input = { businessId: shop.businessId, conversationId: scope.conversationId, orderCode: "TK-999123" };
    for (const path of ["/orders/modify", "/orders/cancel", "/orders/items"]) {
      const response = await request(app).post(`/v1/agent${path}`).set(key).send({ ...input, orderType: "delivery", deliveryAddress: "Dirección ajena" }).expect(200);
      expect(response.body.ok).toBe(false);
    }
    const legacy = await request(app).patch("/v1/agent/orders").set(key).send({ ...input, orderType: "delivery", deliveryAddress: "Dirección ajena" }).expect(200);
    expect(legacy.body.ok).toBe(false);
    const original = await ownerDb().order.findFirstOrThrow({ where: { orderCode: "TK-999123" } });
    expect(original.status).toBe("pending"); expect(original.orderType).toBe("takeaway");
    // A web order is still accessible to the same verified contact by phone.
    await ownerDb().order.update({ where: { id: original.id }, data: { whatsappConversationId: null, customerPhone: "3815550000", status: "delivered" } });
    expect(await invoke(await createNativeTools(scope), "consultar_pedido", { orderCode: "TK-999123" })).toMatchObject({ ok: true });
    expect(await invoke(await createNativeTools(scope), "consultar_pedido", {})).toMatchObject({ ok: true });
  });

  it("una derivación crea un único caso y detiene las demás operaciones", async () => {
    const tools = await createNativeTools(scope);
    const args = { reason: "pedido_humano", summary: "El cliente pide hablar con una persona." };
    const result = await invoke(tools, "derivar_a_persona", args);
    expect(result).toMatchObject({ ok: true });
    // Exact replay can read its receipt even after the handoff changed status.
    expect(await invoke(tools, "derivar_a_persona", args)).toEqual(result);
    expect(await ownerDb().conversationCase.count()).toBe(1);
    await expect(invoke(tools, "buscar_faq", { query: "" })).rejects.toThrow("atención humana");
  });

  it("confirmación, cambios y cancelación solicitan aprobación sin escribir pedidos", async () => {
    for (const [toolName, input] of [["confirmar_pedido", {}], ["modificar_pedido", { orderType: "takeaway" }], ["cancelar_pedido", {}]] as const) {
      const agent = await createNativeAgent(scope, { model: new MockLanguageModelV4({ doGenerate: call(toolName, input) }) });
      const result = await agent.generate({ prompt: "Hacé la operación" });
      expect(result.content.some((part) => part.type === "tool-approval-request")).toBe(true);
    }
    expect(await ownerDb().agentAction.count()).toBe(0);
    expect(await ownerDb().order.count()).toBe(0);
  });

  it("no acepta IDs de negocio ni precios inventados en los argumentos del modelo", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [call("agregar_productos", { businessId: shop.businessId, items: [{ productId: shop.sodaId, quantity: 1, optionValueIds: [], price: 1 }] }), answer("No pude ejecutar esa solicitud.")] });
    const agent = await createNativeAgent(scope, { model });
    await agent.generate({ prompt: "Usá este precio" });
    expect(await ownerDb().whatsappOrderDraftItem.count()).toBe(0);
  });

  it("un fallo tras escribir queda incierto y no repite la operación ni después de reiniciar", async () => {
    let writes = 0;
    const input = { scope, permission: "create_orders" as const, toolName: "test_write", args: { quantity: 1 }, execute: async () => { writes++; throw new Error("provider-secret"); } };
    await expect(executeNativeAction(input)).rejects.toThrow("revisión");
    expect((await ownerDb().agentAction.findFirstOrThrow()).status).toBe("uncertain");
    await expect(executeNativeAction(input)).rejects.toThrow("revisión");
    await expect(createNativeTools(scope)).rejects.toThrow("revisión");
    expect(writes).toBe(1);
  });

  it("serializa procesos concurrentes y conserva el resultado de una acción completada", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    const input = { scope, permission: "create_orders" as const, toolName: "test_write", args: { a: 1, b: 2 }, execute: async () => { writes++; entered(); await gate; return { ok: true }; } };
    const first = executeNativeAction(input);
    await started;
    try { await expect(executeNativeAction({ ...input, args: { b: 2, a: 1 } })).rejects.toThrow("revisión"); }
    finally { release(); }
    expect(await first).toEqual({ ok: true });
    expect(await executeNativeAction({ ...input, args: { b: 2, a: 1 } })).toEqual({ ok: true });
    expect(writes).toBe(1);
  });
});
