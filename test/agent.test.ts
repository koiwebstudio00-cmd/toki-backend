// Herramientas del agente de n8n — docs/api.md §14.
// Incluye el camino completo: borrador → confirmar → pedido, que es el que
// reemplaza a la Edge Function create-order en modo whatsapp.
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { disconnectDb } from "../src/lib/db.js";
import { DB_AVAILABLE, ownerDb, seedShop, TEST_AGENT_KEY } from "./helpers.js";

const app = buildApp();
const key = { "x-api-key": TEST_AGENT_KEY };

describe.runIf(DB_AVAILABLE)("agente", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;
  let conversationId: string;

  beforeEach(async () => {
    s = await seedShop("agente-test");
    const conversation = await ownerDb().whatsappConversation.create({
      data: { businessId: s.businessId, contactId: "wa-1", phone: "3815557777" }
    });
    conversationId = conversation.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const draft = () => ({ businessId: s.businessId, conversationId });

  async function armarBorradorCompleto() {
    await request(app)
      .post("/v1/agent/draft/items")
      .set(key)
      .send({ ...draft(), productId: s.burgerId, quantity: 2, optionValueIds: [s.aPuntoId] })
      .expect(200);
    await request(app)
      .patch("/v1/agent/draft")
      .set(key)
      .send({ ...draft(), customerName: "Ana", orderType: "takeaway", paymentMethod: "cash" })
      .expect(200);
  }

  describe("autenticación", () => {
    it("sin API key, 401", async () => {
      await request(app).get(`/v1/agent/integrations/by-account/x`).expect(401);
    });

    it("con API key inválida, 401", async () => {
      await request(app).get(`/v1/agent/integrations/by-account/x`).set({ "x-api-key": "nope" }).expect(401);
    });
  });

  describe("integración y conversación", () => {
    it("resuelve el negocio desde la cuenta de Zernio", async () => {
      await ownerDb().whatsappIntegration.create({
        data: { businessId: s.businessId, provider: "zernio", providerExternalId: "cuenta-9", isActive: true }
      });
      const res = await request(app).get("/v1/agent/integrations/by-account/cuenta-9").set(key).expect(200);
      expect(res.body.businessId).toBe(s.businessId);
      expect(res.body.business.slug).toBe(s.slug);
      expect(res.body).toHaveProperty("botEnabled");
    });

    it("404 si la cuenta no está conectada o está inactiva", async () => {
      await request(app).get("/v1/agent/integrations/by-account/desconocida").set(key).expect(404);
      await ownerDb().whatsappIntegration.create({
        data: { businessId: s.businessId, provider: "zernio", providerExternalId: "apagada", isActive: false }
      });
      await request(app).get("/v1/agent/integrations/by-account/apagada").set(key).expect(404);
    });

    it("el upsert de conversación no pisa el estado handoff", async () => {
      await ownerDb().whatsappConversation.update({
        where: { id: conversationId },
        data: { status: "handoff", handoffReason: "pedido_humano" }
      });
      const res = await request(app)
        .post("/v1/agent/conversations/upsert")
        .set(key)
        .send({ businessId: s.businessId, contactId: "wa-1", phone: "3815557777" })
        .expect(200);
      expect(res.body.conversationId).toBe(conversationId);
      expect(res.body.status).toBe("handoff");
    });

    it("guarda el mensaje y deduplica por providerMessageId", async () => {
      const body = {
        businessId: s.businessId,
        conversationId,
        direction: "inbound",
        content: "Hola",
        providerMessageId: "msg-1"
      };
      const primero = await request(app).post("/v1/agent/messages").set(key).send(body).expect(200);
      expect(primero.body.duplicate).toBe(false);

      const repetido = await request(app).post("/v1/agent/messages").set(key).send(body).expect(200);
      expect(repetido.body.duplicate).toBe(true);

      expect(await ownerDb().whatsappMessage.count({ where: { conversationId } })).toBe(1);
    });

    it("el alta del mensaje devuelve createdAt para la lógica de ráfaga", async () => {
      const res = await request(app)
        .post("/v1/agent/messages")
        .set(key)
        .send({ businessId: s.businessId, conversationId, direction: "inbound", content: "Hola" })
        .expect(200);
      expect(res.body.createdAt).toBeTruthy();
      expect(new Date(res.body.createdAt).getTime()).not.toBeNaN();
    });

    it("dice si entró un mensaje del cliente después de uno dado", async () => {
      const primero = await request(app)
        .post("/v1/agent/messages")
        .set(key)
        .send({ businessId: s.businessId, conversationId, direction: "inbound", content: "hola" })
        .expect(200);

      const sinNuevos = await request(app)
        .get(`/v1/agent/conversations/${conversationId}/messages?businessId=${s.businessId}&after=${encodeURIComponent(primero.body.createdAt)}&direction=inbound&limit=1`)
        .set(key)
        .expect(200);
      expect(sinNuevos.body.count).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await request(app)
        .post("/v1/agent/messages")
        .set(key)
        .send({ businessId: s.businessId, conversationId, direction: "inbound", content: "una muzza" })
        .expect(200);

      const conNuevos = await request(app)
        .get(`/v1/agent/conversations/${conversationId}/messages?businessId=${s.businessId}&after=${encodeURIComponent(primero.body.createdAt)}&direction=inbound&limit=1`)
        .set(key)
        .expect(200);
      expect(conNuevos.body.count).toBe(1);
    });

    it("devuelve el estado de la conversación", async () => {
      const abierta = await request(app)
        .get(`/v1/agent/conversations/${conversationId}?businessId=${s.businessId}`)
        .set(key)
        .expect(200);
      expect(abierta.body).toMatchObject({ id: conversationId, status: "open" });

      await ownerDb().whatsappConversation.update({
        where: { id: conversationId },
        data: { status: "handoff", handoffReason: "queja" }
      });
      const tomada = await request(app)
        .get(`/v1/agent/conversations/${conversationId}?businessId=${s.businessId}`)
        .set(key)
        .expect(200);
      expect(tomada.body).toMatchObject({ status: "handoff", handoffReason: "queja" });
    });

    it("no devuelve la conversación de otro negocio", async () => {
      const otro = await seedShop("agente-otro-conv");
      await request(app)
        .get(`/v1/agent/conversations/${conversationId}?businessId=${otro.businessId}`)
        .set(key)
        .expect(404);
      await request(app)
        .get(`/v1/agent/conversations/${conversationId}/messages?businessId=${otro.businessId}`)
        .set(key)
        .expect(404);
    });

    it("el mensaje actualiza lastMessageAt de la conversación", async () => {
      await request(app)
        .post("/v1/agent/messages")
        .set(key)
        .send({ businessId: s.businessId, conversationId, direction: "outbound", content: "¡Hola!" })
        .expect(200);
      const c = await ownerDb().whatsappConversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(c.lastMessageAt).toBeTruthy();
    });
  });

  describe("catálogo y contexto", () => {
    it("busca productos del negocio", async () => {
      const res = await request(app)
        .get(`/v1/agent/products/search?businessId=${s.businessId}&q=cheddar`)
        .set(key)
        .expect(200);
      expect(JSON.stringify(res.body)).toMatch(/Doble cheddar/);
    });

    it("trae el detalle de un producto", async () => {
      const res = await request(app)
        .get(`/v1/agent/products/${s.burgerId}?businessId=${s.businessId}`)
        .set(key)
        .expect(200);
      expect(JSON.stringify(res.body)).toMatch(/Punto/);
    });

    it("busca en las preguntas frecuentes", async () => {
      await ownerDb().botFaq.create({
        data: { businessId: s.businessId, question: "¿Hacen envíos?", answer: "Sí, en toda la ciudad." }
      });
      const res = await request(app)
        .get(`/v1/agent/faq/search?businessId=${s.businessId}&q=${encodeURIComponent("envíos")}`)
        .set(key)
        .expect(200);
      expect(JSON.stringify(res.body)).toMatch(/toda la ciudad/);
    });

    it("devuelve el contexto de la conversación", async () => {
      const res = await request(app)
        .get(`/v1/agent/conversations/${conversationId}/context?businessId=${s.businessId}&k=5`)
        .set(key)
        .expect(200);
      expect(res.body).toBeTypeOf("object");
    });

    it("el contexto trae el link del menú público", async () => {
      // Sin esto el agente no puede pasar el menú digital y termina leyendo los
      // productos de a uno, que es lo que pasaba en producción.
      const res = await request(app)
        .get(`/v1/agent/conversations/${conversationId}/context?businessId=${s.businessId}`)
        .set(key)
        .expect(200);
      expect(res.body.business.menu_url).toBe(`${config.FRONT_URL}/${res.body.business.slug}`);
    });

    it("con el businessId de otro negocio no devuelve la conversación", async () => {
      const otro = await seedShop("agente-otro");
      const res = await request(app)
        .get(`/v1/agent/conversations/${conversationId}/context?businessId=${otro.businessId}`)
        .set(key)
        .expect(200);
      // Devuelve el contexto del negocio pedido, pero la conversación (que es de
      // otro) no aparece: las funciones filtran por (conversación, negocio).
      expect(JSON.stringify(res.body)).not.toContain(conversationId);
      expect(JSON.stringify(res.body)).not.toContain("3815557777");
    });
  });

  describe("borrador", () => {
    it("agrega un item con opciones y calcula el precio", async () => {
      const res = await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ ...draft(), productId: s.burgerId, quantity: 2, optionValueIds: [s.aPuntoId, s.pancetaId] })
        .expect(200);
      expect(res.body.ok).toBe(true);
      const items = await ownerDb().whatsappOrderDraftItem.findMany({ where: { businessId: s.businessId } });
      expect(items).toHaveLength(1);
      expect(Number(items[0]!.unitPrice)).toBe(11500);
      expect(Number(items[0]!.totalPrice)).toBe(23000);
    });

    it("quita un item", async () => {
      await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ ...draft(), productId: s.sodaId, quantity: 1 })
        .expect(200);
      const item = await ownerDb().whatsappOrderDraftItem.findFirstOrThrow({ where: { businessId: s.businessId } });

      const res = await request(app)
        .delete(`/v1/agent/draft/items/${item.id}?businessId=${s.businessId}&conversationId=${conversationId}`)
        .set(key)
        .expect(200);
      expect(res.body.ok).toBe(true);
      expect(await ownerDb().whatsappOrderDraftItem.count({ where: { businessId: s.businessId } })).toBe(0);
    });

    it("completa los datos de a poco sin pisar lo anterior", async () => {
      await request(app).patch("/v1/agent/draft").set(key).send({ ...draft(), customerName: "Ana" }).expect(200);
      await request(app).patch("/v1/agent/draft").set(key).send({ ...draft(), orderType: "takeaway" }).expect(200);

      const d = await ownerDb().whatsappOrderDraft.findFirstOrThrow({ where: { conversationId } });
      expect(d.customerName).toBe("Ana");
      expect(d.orderType).toBe("takeaway");
    });

    it("rechaza un medio de pago deshabilitado", async () => {
      await ownerDb().paymentSettings.update({
        where: { businessId: s.businessId },
        data: { transferEnabled: false }
      });
      const res = await request(app)
        .patch("/v1/agent/draft")
        .set(key)
        .send({ ...draft(), paymentMethod: "transfer" })
        .expect(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/habilitado/i);
    });

    it("acepta mercadopago: la función SQL decide si el negocio lo tiene activo", async () => {
      // El enum de Zod tiene que cubrir los tres medios que acepta la base. Si
      // recorta mercadopago, el agente recibe un 400 que no sabe explicarle al
      // cliente en vez del motivo legible que devuelve la función.
      await ownerDb().paymentSettings.update({
        where: { businessId: s.businessId },
        data: { mercadopagoEnabled: true }
      });
      const res = await request(app)
        .patch("/v1/agent/draft")
        .set(key)
        .send({ ...draft(), paymentMethod: "mercadopago" })
        .expect(200);
      expect(res.body.ok).toBe(true);
    });

    it("cancela el borrador", async () => {
      await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ ...draft(), productId: s.sodaId, quantity: 1 })
        .expect(200);
      const res = await request(app)
        .delete(`/v1/agent/draft?businessId=${s.businessId}&conversationId=${conversationId}`)
        .set(key)
        .expect(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("confirmar el pedido", () => {
    it("crea el pedido con origen whatsapp y lo ata a la conversación", async () => {
      await armarBorradorCompleto();
      const res = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(201);

      expect(res.body.ok).toBe(true);
      expect(res.body.total).toBe(20000);

      const order = await ownerDb().order.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(order.source).toBe("whatsapp");
      expect(order.whatsappConversationId).toBe(conversationId);
      expect(order.customerPhone).toBe("3815557777");

      const d = await ownerDb().whatsappOrderDraft.findFirstOrThrow({ where: { conversationId } });
      expect(d.status).toBe("confirmed");
      expect(d.orderId).toBe(order.id);

      // El stock se descontó igual que en el checkout web.
      const burger = await ownerDb().product.findUniqueOrThrow({ where: { id: s.burgerId } });
      expect(burger.stockQuantity).toBe(8);
    });

    it("confirmar dos veces devuelve el mismo pedido", async () => {
      await armarBorradorCompleto();
      const primero = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(201);
      const segundo = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(200);

      expect(segundo.body).toMatchObject({ ok: true, yaExistia: true, orderCode: primero.body.orderCode });
      expect(await ownerDb().order.count({ where: { businessId: s.businessId } })).toBe(1);
    });

    it("avisa qué falta en vez de confirmar a medias", async () => {
      await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ ...draft(), productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId] })
        .expect(200);

      const sinNombre = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(200);
      expect(sinNombre.body).toMatchObject({ ok: false });
      expect(sinNombre.body.error).toMatch(/nombre/i);

      await request(app)
        .patch("/v1/agent/draft")
        .set(key)
        .send({ ...draft(), customerName: "Ana", orderType: "delivery", paymentMethod: "cash" })
        .expect(200);
      const sinDireccion = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(200);
      expect(sinDireccion.body.error).toMatch(/dirección/i);
    });

    it("no confirma con el local cerrado", async () => {
      await armarBorradorCompleto();
      await ownerDb().business.update({ where: { id: s.businessId }, data: { manualStatus: "closed" } });
      const res = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(200);
      expect(res.body).toMatchObject({ ok: false });
      expect(res.body.error).toMatch(/cerrado/i);
    });

    it("no confirma sin stock y lo explica", async () => {
      await armarBorradorCompleto();
      await ownerDb().product.update({ where: { id: s.burgerId }, data: { stockQuantity: 1 } });
      const res = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(200);
      expect(res.body).toMatchObject({ ok: false });
      expect(res.body.error).toMatch(/stock/i);
    });

    it("sin borrador avisa que no hay nada armado", async () => {
      const res = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(200);
      expect(res.body).toMatchObject({ ok: false });
      expect(res.body.error).toMatch(/no hay/i);
    });
  });

  describe("pedido confirmado", () => {
    it("consulta el estado", async () => {
      await armarBorradorCompleto();
      const creado = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(201);
      const res = await request(app)
        .get(`/v1/agent/orders/status?businessId=${s.businessId}&conversationId=${conversationId}`)
        .set(key)
        .expect(200);
      expect(JSON.stringify(res.body)).toContain(creado.body.orderCode);
    });

    it("cambia la forma de entrega del pedido", async () => {
      await armarBorradorCompleto();
      const creado = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(201);

      const res = await request(app)
        .patch("/v1/agent/orders")
        .set(key)
        .send({ ...draft(), orderCode: creado.body.orderCode, orderType: "delivery", deliveryAddress: "Av. Siempre Viva 742" })
        .expect(200);
      expect(res.body.ok).toBe(true);

      const order = await ownerDb().order.findUniqueOrThrow({ where: { id: creado.body.id } });
      expect(order.orderType).toBe("delivery");
      expect(order.deliveryAddress).toBe("Av. Siempre Viva 742");
    });

    it("agrega los items nuevos del borrador a un pedido abierto", async () => {
      await armarBorradorCompleto();
      const creado = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(201);

      await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ ...draft(), productId: s.sodaId, quantity: 1 })
        .expect(200);

      const res = await request(app)
        .post("/v1/agent/orders/items")
        .set(key)
        .send({ ...draft(), orderCode: creado.body.orderCode })
        .expect(200);
      expect(res.body.ok).toBe(true);

      const items = await ownerDb().orderItem.findMany({ where: { orderId: creado.body.id } });
      expect(items).toHaveLength(2);
    });

    it("sin código toma el último pedido del contacto", async () => {
      await armarBorradorCompleto();
      const creado = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(201);

      // Es el caso más común: "cambiame la dirección", sin decir qué pedido.
      const res = await request(app)
        .patch("/v1/agent/orders")
        .set(key)
        .send({ ...draft(), orderType: "delivery", deliveryAddress: "Muñecas 500" })
        .expect(200);
      expect(res.body.ok).toBe(true);

      const order = await ownerDb().order.findUniqueOrThrow({ where: { id: creado.body.id } });
      expect(order.deliveryAddress).toBe("Muñecas 500");
    });

    it("deriva la conversación a una persona", async () => {
      const res = await request(app)
        .post(`/v1/agent/conversations/${conversationId}/handoff`)
        .set(key)
        .send({ businessId: s.businessId, reason: "queja" })
        .expect(200);
      expect(res.body.ok).toBe(true);
      const c = await ownerDb().whatsappConversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(c.status).toBe("handoff");
      expect(c.handoffReason).toBe("queja");
    });
  });

  describe("comprobante de pago", () => {
    function mockDownload(contentType = "image/jpeg") {
      return vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": contentType } })
      );
    }

    async function pedidoConfirmado() {
      await armarBorradorCompleto();
      const creado = await request(app).post("/v1/agent/draft/confirm").set(key).send(draft()).expect(201);
      return creado.body as { id: string; orderCode: string };
    }

    it("guarda el comprobante contra el pedido de la conversación", async () => {
      const order = await pedidoConfirmado();
      mockDownload();

      const res = await request(app)
        .post("/v1/agent/payment-proofs")
        .set(key)
        .send({ ...draft(), mediaUrl: "https://zernio.com/media/1.jpg", mediaType: "image" })
        .expect(200);

      expect(res.body).toMatchObject({ ok: true, duplicate: false, orderCode: order.orderCode });
      const proof = await ownerDb().orderPaymentProof.findFirstOrThrow({ where: { orderId: order.id } });
      expect(proof.status).toBe("pending");
      expect(proof.storagePath).toContain(`${s.businessId}/payment-proofs/${order.orderCode}/`);
    });

    it("el mismo mensaje no guarda dos comprobantes", async () => {
      await pedidoConfirmado();
      mockDownload();
      const body = { ...draft(), mediaUrl: "https://zernio.com/media/1.jpg", providerMessageId: "msg-9" };

      await request(app).post("/v1/agent/payment-proofs").set(key).send(body).expect(200);
      const repetido = await request(app).post("/v1/agent/payment-proofs").set(key).send(body).expect(200);

      expect(repetido.body).toMatchObject({ ok: true, duplicate: true });
      expect(await ownerDb().orderPaymentProof.count({ where: { businessId: s.businessId } })).toBe(1);
    });

    it("sin pedido no guarda nada y lo dice", async () => {
      mockDownload();
      const res = await request(app)
        .post("/v1/agent/payment-proofs")
        .set(key)
        .send({ ...draft(), mediaUrl: "https://zernio.com/media/1.jpg" })
        .expect(200);
      expect(res.body).toMatchObject({ ok: false });
      expect(res.body.error).toMatch(/pedido/i);
      expect(await ownerDb().orderPaymentProof.count({ where: { businessId: s.businessId } })).toBe(0);
    });

    it("rechaza un archivo que no es imagen ni PDF", async () => {
      await pedidoConfirmado();
      mockDownload("text/html");
      const res = await request(app)
        .post("/v1/agent/payment-proofs")
        .set(key)
        .send({ ...draft(), mediaUrl: "https://zernio.com/media/1.html" })
        .expect(200);
      expect(res.body).toMatchObject({ ok: false });
      expect(res.body.error).toMatch(/imagen|PDF/i);
    });
  });
});
