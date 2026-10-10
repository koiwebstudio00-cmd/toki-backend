import { createHmac, randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCatalog } from "../src/modules/catalog/service.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { disconnectDb, withDb } from "../src/lib/db.js";
import { acceptWebhook } from "../src/modules/agent/webhook.js";
import { processNextAgentTurn, recoverInterruptedTurns } from "../src/modules/agent/worker.js";
import { requestApproval, approvalButtons, consumeApproval } from "../src/modules/agent/approvals.js";
import { draftAddItems, draftSetDetails, confirmDraft } from "../src/modules/agent/service.js";
import { DB_AVAILABLE, ownerDb, seedShop, bearer, authCtx, addMember, createUser, createBusiness } from "./helpers.js";
vi.mock("../src/lib/r2.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/lib/r2.js")>();
  return { ...original, putObject: vi.fn().mockResolvedValue(undefined) };
});
import { trustedWhatsappMediaUrl, zernioDownload } from "../src/lib/zernio.js";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const answer = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
const call = (toolName: string, input: object) => ({ content: [{ type: "tool-call" as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] });
const model = () => new MockLanguageModelV4({ doGenerate: answer("Hola, ¿en qué te puedo ayudar?") });
const originalConfig = { ...config };
const app = buildApp();

describe.runIf(DB_AVAILABLE)("canal nativo WhatsApp de punta a punta", () => {
  let shop: Awaited<ReturnType<typeof seedShop>>;
  let sequence = 0;
  const event = (text = "Hola", extra: Record<string, unknown> = {}) => ({
    id: randomUUID(), event: "message.received", timestamp: new Date().toISOString(), account: { accountId: "account-test" }, conversation: { id: "provider-thread" },
    message: { id: randomUUID(), platformMessageId: randomUUID(), platform: "whatsapp", direction: "incoming", text,
      sender: { id: "543815550000", phoneNumber: "+543815550000" }, attachments: [], sentAt: new Date(Date.now() + ++sequence).toISOString() }, ...extra
  });
  async function receive(body = event()) {
    await acceptWebhook(body);
    await ownerDb().agentTurn.updateMany({ data: { availableAt: new Date(0) } });
    return ownerDb().agentTurn.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  }
  beforeEach(async () => {
    shop = await seedShop(); sequence = 0;
    Object.assign(config, { ZERNIO_WEBHOOK_SECRET: "channel-test-secret", ZERNIO_API_KEY: "provider-test-key", AI_GATEWAY_API_KEY: "model-test-key", AI_GATEWAY_MODEL: "test/model", AGENT_WORKER_ENABLED: true });
    await ownerDb().botSettings.update({ where: { businessId: shop.businessId }, data: { engine: "native" } });
    await ownerDb().whatsappIntegration.create({ data: { businessId: shop.businessId, isActive: true, provider: "zernio", providerExternalId: "account-test" } });
  });
  afterEach(() => { Object.assign(config, originalConfig); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });

  it("verifica la firma cruda, guarda una sola vez y no consume IA dentro del webhook", async () => {
    const payload = JSON.stringify(event());
    const signature = createHmac("sha256", config.ZERNIO_WEBHOOK_SECRET).update(payload).digest("hex");
    await request(app).post("/v1/webhooks/zernio").set("Content-Type", "application/json").send(payload).expect(401);
    await request(app).post("/v1/webhooks/zernio").set("Content-Type", "application/json").set("X-Zernio-Signature", signature).send(payload + " ").expect(401);
    for (let i = 0; i < 2; i++) await request(app).post("/v1/webhooks/zernio").set("Content-Type", "application/json").set("X-Zernio-Signature", signature).send(payload).expect(200);
    expect(await ownerDb().agentTurn.count()).toBe(1);
    expect(await ownerDb().whatsappMessage.count()).toBe(1);
    expect((await ownerDb().agentTurn.findFirstOrThrow()).status).toBe("queued");
  });

  it("repetir un mensaje con otro evento tampoco duplica, y una cuenta ambigua no se enruta", async () => {
    const body = event(); await receive(body); await acceptWebhook({ ...body, id: randomUUID() });
    expect(await ownerDb().agentTurn.count()).toBe(1);
    const user = await createUser("ambiguous@test.com"); const businessId = await createBusiness(user, "ambiguous");
    await ownerDb().whatsappIntegration.create({ data: { businessId, isActive: true, providerExternalId: "account-test" } });
    await acceptWebhook(event()); expect(await ownerDb().agentTurn.count()).toBe(1);
  });

  it("genera, persiste el envío y registra la respuesta sin volver a llamar al modelo", async () => {
    const turn = await receive(); const llm = model();
    expect(await processNextAgentTurn({ model: llm })).toBe(true);
    expect((await ownerDb().agentTurn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe("ready");
    const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { messageId: "out-1" } }), { status: 200 }));
    vi.stubGlobal("fetch", send);
    await processNextAgentTurn({ model: llm });
    expect(send).toHaveBeenCalledOnce(); expect(llm.doGenerateCalls).toHaveLength(1);
    const init = send.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ "Idempotency-Key": turn.id });
    expect(JSON.parse(init.body as string)).toMatchObject({ accountId: "account-test", message: "Hola, ¿en qué te puedo ayudar?" });
    expect((await ownerDb().agentTurn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe("sent");
    expect(await ownerDb().whatsappMessage.count({ where: { direction: "outbound" } })).toBe(1);
    expect(await processNextAgentTurn({ model: llm })).toBe(false);
  });

  it("transcribe audio verificado antes del agente y no envía desde la generación", async () => {
    Object.assign(config, { OPENAI_API_KEY: "fake-openai-key", OPENAI_MODEL: "gpt-5.4-mini" });
    const body = event();
    const turn = await receive(event("", { message: { ...body.message, text: null,
      attachments: [{ type: "audio", url: `${config.ZERNIO_BASE_URL}/whatsapp/media/audio123`, mimeType: "audio/ogg" }] } }));
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith(`${config.ZERNIO_BASE_URL}/whatsapp/media/`)) {
        return new Response("OggS-fake-audio", { headers: { "Content-Type": "audio/ogg" } });
      }
      expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
      return new Response(JSON.stringify({ text: "Quiero una gaseosa para retirar." }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const llm = model();
    await processNextAgentTurn({ model: llm });
    expect((await ownerDb().agentTurn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe("ready");
    expect(JSON.stringify(llm.doGenerateCalls[0]!.prompt)).toContain("Quiero una gaseosa para retirar.");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await ownerDb().whatsappMessage.count({ where: { direction: "outbound" } })).toBe(0);
  });

  it("agrupa una ráfaga y serializa los workers de una conversación", async () => {
    await receive(event("Quiero una gaseosa")); await receive(event("Para retirar"));
    const llm = model();
    await Promise.all([processNextAgentTurn({ model: llm }), processNextAgentTurn({ model: llm })]);
    await processNextAgentTurn({ model: llm });
    expect(llm.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(llm.doGenerateCalls[0]!.prompt)).toContain("Para retirar");
    expect(await ownerDb().agentTurn.count({ where: { status: "skipped" } })).toBe(1);
  });

  it("una pausa durante la generación impide enviar", async () => {
    await receive();
    const llm = new MockLanguageModelV4({ doGenerate: async () => {
      await ownerDb().botSettings.update({ where: { businessId: shop.businessId }, data: { isEnabled: false } }); return answer("Hola");
    } });
    await processNextAgentTurn({ model: llm });
    expect((await ownerDb().agentTurn.findFirstOrThrow()).status).toBe("skipped");
  });

  it("un timeout de envío queda incierto y nunca se reenvía automáticamente", async () => {
    await receive(); await processNextAgentTurn({ model: model() });
    const send = vi.fn().mockRejectedValue(new Error("secret-provider-error")); vi.stubGlobal("fetch", send);
    await processNextAgentTurn(); await processNextAgentTurn();
    expect(send).toHaveBeenCalledOnce();
    const turn = await ownerDb().agentTurn.findFirstOrThrow();
    expect(turn.status).toBe("uncertain"); expect(JSON.stringify(turn)).not.toContain("secret-provider-error");
    expect((await ownerDb().whatsappConversation.findFirstOrThrow()).status).toBe("handoff");
  });

  it("conserva un fallo de entrega recibido antes de la respuesta HTTP de envío", async () => {
    await receive(); await processNextAgentTurn({ model: model() });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      await acceptWebhook({ id: randomUUID(), event: "message.failed", account: { accountId: "account-test" }, message: { platform: "whatsapp", platformMessageId: "early-failure" } });
      return new Response(JSON.stringify({ success: true, data: { messageId: "early-failure" } }));
    }));
    await processNextAgentTurn();
    expect((await ownerDb().agentTurn.findFirstOrThrow()).errorCode).toBe("delivery_failed");
    expect((await ownerDb().whatsappConversation.findFirstOrThrow()).status).toBe("handoff");
  });

  it("recupera una caída del worker sin repetir acciones", async () => {
    const turn = await receive(); await ownerDb().agentTurn.update({ where: { id: turn.id }, data: { status: "running", claimedAt: new Date(0) } });
    await recoverInterruptedTurns();
    expect((await ownerDb().agentTurn.findFirstOrThrow()).status).toBe("failed");
    expect(await processNextAgentTurn({ model: model() })).toBe(false);
  });

  it("respeta standby, respuestas humanas y la ventana de WhatsApp", async () => {
    await receive(event("Hola", { metadata: { standby: true } }));
    expect((await ownerDb().agentTurn.findFirstOrThrow()).status).toBe("skipped");
    await ownerDb().whatsappConversation.updateMany({ data: { status: "open" } });
    const inbound = event(); await receive(inbound);
    await acceptWebhook({ ...event(), event: "message.sent", message: { ...inbound.message, id: randomUUID(), platformMessageId: "human-reply", direction: "outgoing", source: "whatsapp_business_app", sender: { id: "account-test" } } });
    expect((await ownerDb().whatsappConversation.findFirstOrThrow()).status).toBe("handoff");
    await ownerDb().whatsappConversation.updateMany({ data: { status: "open" } });
    await ownerDb().whatsappMessage.updateMany({ where: { direction: "inbound" }, data: { createdAt: new Date(Date.now() - 25 * 3600000) } });
    const llm = model(); await processNextAgentTurn({ model: llm }); expect(llm.doGenerateCalls).toHaveLength(0);
  });

  async function prepareOrder() {
    const turn = await receive(event("Una gaseosa, retiro, efectivo. Soy Ana."));
    await draftAddItems({ ...turn, items: [{ productId: shop.sodaId, quantity: 1, optionValueIds: [] }] });
    await draftSetDetails({ ...turn, customerName: "Ana", orderType: "takeaway", paymentMethod: "cash" });
    return turn;
  }
  it("el modelo pide aprobación y un botón verificado crea un único pedido", async () => {
    await prepareOrder();
    const llm = new MockLanguageModelV4({ doGenerate: [call("confirmar_pedido", {}), answer("Revisá el resumen y confirmá con el botón.")] });
    await processNextAgentTurn({ model: llm });
    expect(await ownerDb().order.count()).toBe(0);
    const approval = await ownerDb().agentApproval.findFirstOrThrow();
    const prepared = await ownerDb().agentTurn.findFirstOrThrow();
    expect(prepared.reply).toContain("2.500,00"); expect(prepared.status).toBe("ready");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { messageId: "approval-out" } }))));
    await processNextAgentTurn();
    const incoming = event("Confirmar", { metadata: { interactiveType: "button_reply", interactiveId: approvalButtons(approval.id)[0]!.payload } });
    await receive(incoming);
    const reply = new MockLanguageModelV4({ doGenerate: answer("Tu pedido quedó confirmado.") });
    await processNextAgentTurn({ model: reply });
    expect(await ownerDb().order.count()).toBe(1);
    expect((await ownerDb().agentApproval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("approved");
    await acceptWebhook({ ...incoming, id: randomUUID() }); expect(await ownerDb().order.count()).toBe(1);
    expect(JSON.stringify(reply.doGenerateCalls[0]!.prompt)).toContain("resultado_confirmacion_del_cliente");
  });

  it("rechaza cambios de precio posteriores al resumen y no acepta un sí de texto", async () => {
    const turn = await prepareOrder(); await requestApproval(turn, "confirmar_pedido", {});
    const approval = await ownerDb().agentApproval.findFirstOrThrow();
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    await ownerDb().product.update({ where: { id: shop.sodaId }, data: { price: 3000 } });
    await receive(event("Confirmar", { metadata: { interactiveType: "button_reply", interactiveId: approvalButtons(approval.id)[0]!.payload } }));
    const llm = model(); await processNextAgentTurn({ model: llm });
    expect(await ownerDb().order.count()).toBe(0); expect(JSON.stringify(llm.doGenerateCalls[0]!.prompt)).toContain("importes cambiaron");
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    const next = await receive(event("Confirmá")); await requestApproval(next, "confirmar_pedido", {});
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    await receive(event("sí")); await processNextAgentTurn({ model: model() });
    expect(await ownerDb().order.count()).toBe(0);
    expect(await ownerDb().agentApproval.count({ where: { status: "pending" } })).toBe(0);
  });


  it("recibe el carrito web completo con cupón incluso si llega otra frase en la ráfaga", async () => {
    await ownerDb().business.update({ where: { id: shop.businessId }, data: { whatsappPhone: "543810000000" } });
    await ownerDb().coupon.create({ data: { businessId: shop.businessId, code: "WEB10", discountType: "percent", discountValue: 10 } });
    const checkout = await prepareCatalog("shop-test", { requestId: randomUUID(), customer: { name: "Ana", phone: "543815550000" }, orderType: "takeaway", paymentMethod: "cash", couponCode: "WEB10", items: [{ productId: shop.sodaId, quantity: 2 }] });
    await receive(event(checkout.message)); await receive(event("Gracias"));
    const llm = new MockLanguageModelV4({ doGenerate: [call("recibir_pedido_catalogo", {}), answer("Revisá y confirmá tu pedido del catálogo.")] });
    await processNextAgentTurn({ model: llm }); // Older burst member is superseded.
    await processNextAgentTurn({ model: llm });
    const approval = await ownerDb().agentApproval.findFirstOrThrow();
    expect(approval.toolName).toBe("recibir_pedido_catalogo");
    expect((approval.quote as { total: number }).total).toBe(4500);
    expect(await ownerDb().order.count()).toBe(0); expect(await ownerDb().whatsappOrderDraft.count()).toBe(0);
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    const decision = await receive(event("Confirmar", { metadata: { interactiveType: "button_reply", interactiveId: approvalButtons(approval.id)[0]!.payload } }));
    await consumeApproval(decision, approvalButtons(approval.id)[0]!.payload);
    const order = await ownerDb().order.findFirstOrThrow();
    expect(Number(order.total)).toBe(4500); expect(order.couponCode).toBe("WEB10"); expect(order.source).toBe("web");
    expect(order.whatsappConversationId).toBe(decision.conversationId);
  });

  it("una solicitud web editada no se reconstruye ni crea un pedido alternativo", async () => {
    await ownerDb().business.update({ where: { id: shop.businessId }, data: { whatsappPhone: "543810000000" } });
    const checkout = await prepareCatalog("shop-test", { requestId: randomUUID(), customer: { name: "Ana", phone: "543815550000" }, orderType: "takeaway", paymentMethod: "cash", items: [{ productId: shop.sodaId, quantity: 1 }] });
    await receive(event(checkout.message.replace("Gaseosa", "Otra cosa")));
    const llm = new MockLanguageModelV4({ doGenerate: [call("recibir_pedido_catalogo", {}), answer("El mensaje cambió; actualizá el carrito y envialo de nuevo.")] });
    await processNextAgentTurn({ model: llm });
    expect(await ownerDb().order.count()).toBe(0); expect(await ownerDb().agentApproval.count()).toBe(0);
    expect(JSON.stringify(llm.doGenerateCalls[1]!.prompt)).toContain("mensaje fue modificado");
  });

  it("modificación y cancelación aprobadas reutilizan precios y efectos de stock", async () => {
    const first = await prepareOrder();
    const created = await confirmDraft(first.businessId, first.conversationId);
    expect(created.ok).toBe(true);
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    const change = await receive(event("Sumá otra gaseosa"));
    await requestApproval(change, "modificar_pedido", { add: [{ productId: shop.sodaId, quantity: 1, optionValueIds: [] }] });
    const proposed = await ownerDb().agentApproval.findFirstOrThrow({ where: { status: "pending" } });
    expect(Number((await ownerDb().order.findFirstOrThrow()).total)).toBe(2500);
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    const accepted = await receive(event("Confirmar"));
    await consumeApproval(accepted, approvalButtons(proposed.id)[0]!.payload);
    expect(Number((await ownerDb().order.findFirstOrThrow()).total)).toBe(5000);
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    const cancel = await receive(event("Cancelalo"));
    await requestApproval(cancel, "cancelar_pedido", {});
    const cancellation = await ownerDb().agentApproval.findFirstOrThrow({ where: { status: "pending" } });
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    const decision = await receive(event("Confirmar"));
    await consumeApproval(decision, approvalButtons(cancellation.id)[0]!.payload);
    expect((await ownerDb().order.findFirstOrThrow()).status).toBe("cancelled");
    expect(await ownerDb().orderModification.count()).toBe(1);
  });

  it("un botón de otro contacto o una firma alterada no autoriza operaciones", async () => {
    const first = await prepareOrder(); await requestApproval(first, "confirmar_pedido", {});
    const approval = await ownerDb().agentApproval.findFirstOrThrow();
    const otherEvent = event();
    otherEvent.message.sender.id = "543815559999"; otherEvent.message.sender.phoneNumber = "+543815559999"; otherEvent.conversation.id = "other-thread";
    const other = await receive(otherEvent);
    await consumeApproval(other, approvalButtons(approval.id)[0]!.payload);
    expect(await ownerDb().order.count()).toBe(0);
    expect((await ownerDb().agentApproval.findFirstOrThrow()).status).toBe("pending");
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    const ours = await receive(event());
    await consumeApproval(ours, approvalButtons(approval.id)[0]!.payload.slice(0, -1) + "X");
    expect(await ownerDb().order.count()).toBe(0);
    expect((await ownerDb().agentApproval.findFirstOrThrow()).status).toBe("expired");
  });

  it("una decisión negativa o vencida nunca ejecuta el pedido", async () => {
    const first = await prepareOrder(); await requestApproval(first, "confirmar_pedido", {});
    const approval = await ownerDb().agentApproval.findFirstOrThrow();
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    const decision = await receive(event("No confirmar"));
    expect(await consumeApproval(decision, approvalButtons(approval.id)[1]!.payload)).toMatchObject({ denied: true });
    expect(await ownerDb().order.count()).toBe(0);
    await requestApproval(decision, "confirmar_pedido", {});
    const next = await ownerDb().agentApproval.findFirstOrThrow({ where: { status: "pending" } });
    await ownerDb().agentApproval.update({ where: { id: next.id }, data: { expiresAt: new Date(0) } });
    await consumeApproval(decision, approvalButtons(next.id)[0]!.payload);
    expect(await ownerDb().order.count()).toBe(0);
  });

  it("la derivación propia envía el aviso y deja la conversación para el equipo", async () => {
    await receive(event("Necesito una persona"));
    const llm = new MockLanguageModelV4({ doGenerate: [call("derivar_a_persona", { reason: "consulta", summary: "El cliente pidió atención humana." }), answer("Ya dejé tu consulta al equipo.")] });
    await processNextAgentTurn({ model: llm });
    expect((await ownerDb().agentTurn.findFirstOrThrow()).status).toBe("ready");
    const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { messageId: "handoff-out" } }))); vi.stubGlobal("fetch", send);
    await processNextAgentTurn();
    expect(send).toHaveBeenCalledOnce(); expect((await ownerDb().whatsappConversation.findFirstOrThrow()).status).toBe("handoff");
    await receive(event("Gracias")); expect(await processNextAgentTurn({ model: model() })).toBe(false);
  });

  it("guarda el adjunto verificado en privado sin acreditar el pago", async () => {
    const first = await prepareOrder(); await confirmDraft(first.businessId, first.conversationId);
    await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    Object.assign(config, { R2_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "storage-test", R2_SECRET_ACCESS_KEY: "storage-test" });
    const incoming = event("Te paso el comprobante");
    const mediaEvent = { ...incoming, message: { ...incoming.message, attachments: [{ type: "image", url: "https://zernio.com/api/v1/whatsapp/media/123?accountId=untrusted" }] } };
    await acceptWebhook(mediaEvent); await ownerDb().agentTurn.updateMany({ data: { availableAt: new Date(0) } });
    const fetch = vi.fn().mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })); vi.stubGlobal("fetch", fetch);
    const llm = new MockLanguageModelV4({ doGenerate: [call("guardar_comprobante", {}), answer("Guardé el comprobante para que el equipo lo revise.")] });
    await processNextAgentTurn({ model: llm });
    expect(await ownerDb().orderPaymentProof.count()).toBe(1);
    expect((await ownerDb().order.findFirstOrThrow()).paymentStatus).not.toBe("paid");
    for (const call of fetch.mock.calls) expect(String(call[0])).toContain("accountId=account-test");
  });

  it("la revisión conserva auditoría y no reenvía un resultado incierto", async () => {
    const turn = await receive();
    await ownerDb().agentTurn.update({ where: { id: turn.id }, data: { status: "uncertain", reply: "Hola", updatedAt: new Date(0) } });
    await ownerDb().agentAction.create({ data: { businessId: turn.businessId, conversationId: turn.conversationId, messageId: turn.messageId, toolName: "agregar_productos", inputHash: "test", status: "uncertain" } });
    await request(app).post(`/v1/settings/bot/channel/turns/${turn.id}/review`).set(bearer(shop.owner)).send({ action: "retry", note: "Revisé la conversación completa." }).expect(409);
    await request(app).post(`/v1/settings/bot/channel/turns/${turn.id}/review`).set(bearer(shop.owner)).send({ action: "reviewed", note: "El pedido existe; ya lo atendió el equipo." }).expect(200);
    const action = await ownerDb().agentAction.findFirstOrThrow(); expect(action.status).toBe("completed"); expect(action.result).toMatchObject({ manualReview: true });
    expect((await ownerDb().agentTurn.findFirstOrThrow()).status).toBe("skipped");
  });

  it("limita consumo por negocio y deja un aviso operativo", async () => {
    await ownerDb().botSettings.update({ where: { businessId: shop.businessId }, data: { dailyTurnLimit: 1 } });
    await receive(); await processNextAgentTurn({ model: model() }); await ownerDb().agentTurn.updateMany({ data: { status: "sent" } });
    await receive(); const llm = model(); await processNextAgentTurn({ model: llm });
    expect(llm.doGenerateCalls).toHaveLength(0);
    expect(await ownerDb().agentTurn.count({ where: { errorCode: "daily_limit" } })).toBe(1);
  });

  it("el panel exige admin y mantiene aislados los turnos y su revisión", async () => {
    const turn = await receive();
    await request(app).get("/v1/settings/bot/channel").set(bearer(shop.owner)).expect(200);
    const staff = await createUser("agent-staff@test.com"); await addMember(shop.businessId, staff, "staff");
    await request(app).get("/v1/settings/bot/channel").set(bearer(staff)).expect(403);
    const other = await createUser("agent-other@test.com"); await createBusiness(other, "other-channel");
    await request(app).post(`/v1/settings/bot/channel/turns/${turn.id}/review`).set(bearer(other)).send({ action: "reviewed", note: "Revisé los pedidos y mensajes." }).expect(404);
    await expect(withDb(authCtx(shop.owner), tx => tx.agentTurn.findMany())).rejects.toThrow();
  });
});

describe("descarga de medios del canal", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("no envía credenciales a hosts arbitrarios ni otros endpoints", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const url of ["https://attacker.test/file.jpg", "https://zernio.com/api/v1/accounts", "http://zernio.com/api/v1/whatsapp/media/1", "https://zernio.com/api/v1/whatsapp/media/a%2fb"]) {
      await expect(zernioDownload(url)).rejects.toThrow("canal");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(trustedWhatsappMediaUrl("https://zernio.com/api/v1/whatsapp/media/123?accountId=other", "ours")).toContain("accountId=ours");
  });
  it("corta el stream al superar el límite y prohíbe redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(11), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetch); const old = config.ZERNIO_API_KEY; config.ZERNIO_API_KEY = "test-key";
    try { await expect(zernioDownload("https://zernio.com/api/v1/whatsapp/media/123", 10)).rejects.toThrow("tamaño"); }
    finally { config.ZERNIO_API_KEY = old; }
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });
});
