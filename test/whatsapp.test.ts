// Inbox de WhatsApp y conexión con Zernio — docs/api.md §12.
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { bearer, DB_AVAILABLE, ownerDb, seedShop } from "./helpers.js";

const app = buildApp();

/** Respuestas de Zernio simuladas: los tests no salen a internet. */
function mockZernio(responses: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`fetch no esperado: ${url}`);
    return new Response(JSON.stringify(responses[match]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
}

describe.runIf(DB_AVAILABLE)("whatsapp", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;
  let conversationId: string;

  beforeEach(async () => {
    s = await seedShop("wa-test");
    const conversation = await ownerDb().whatsappConversation.create({
      data: { businessId: s.businessId, contactId: "contacto-1", phone: "3815550001", lastMessageAt: new Date() }
    });
    conversationId = conversation.id;
    await ownerDb().whatsappMessage.createMany({
      data: [
        { businessId: s.businessId, conversationId, direction: "inbound", content: "Hola" },
        { businessId: s.businessId, conversationId, direction: "outbound", content: "¡Hola! ¿Qué te gustaría pedir?" }
      ]
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  describe("integración", () => {
    it("devuelve el estado sin tokens ni metadata cruda", async () => {
      await ownerDb().whatsappIntegration.create({
        data: {
          businessId: s.businessId,
          provider: "zernio",
          isActive: true,
          phoneNumber: "+543815550000",
          accessTokenEncrypted: "secreto",
          providerMetadata: { connectedAt: "2026-09-01T10:00:00.000Z", zernioProfileId: "p1" }
        }
      });
      const res = await request(app).get("/v1/whatsapp/integration").set(bearer(s.owner)).expect(200);
      expect(res.body).toEqual({
        provider: "zernio",
        isActive: true,
        phoneNumber: "+543815550000",
        connectedAt: "2026-09-01T10:00:00.000Z"
      });
      expect(JSON.stringify(res.body)).not.toContain("secreto");
    });

    it("sin integración devuelve el estado vacío", async () => {
      const res = await request(app).get("/v1/whatsapp/integration").set(bearer(s.owner)).expect(200);
      expect(res.body).toMatchObject({ provider: null, isActive: false });
    });

    it("el staff no puede tocar la conexión", async () => {
      await request(app).get("/v1/whatsapp/integration").set(bearer(s.staff)).expect(403);
      await request(app)
        .post("/v1/whatsapp/connect/start")
        .set(bearer(s.staff))
        .send({ redirectUrl: "https://app.toki.ar/dashboard/whatsapp" })
        .expect(403);
    });

    it("crea el perfil en Zernio y deja la integración inactiva hasta completar", async () => {
      mockZernio({
        "/profiles": { profile: { _id: "profile-123" } },
        "/connect/whatsapp": { authUrl: "https://zernio.com/connect/abc", state: "st-1" }
      });

      const res = await request(app)
        .post("/v1/whatsapp/connect/start")
        .set(bearer(s.owner))
        .send({ redirectUrl: "https://app.toki.ar/dashboard/whatsapp" })
        .expect(200);

      expect(res.body).toMatchObject({ authUrl: "https://zernio.com/connect/abc", profileId: "profile-123" });
      const row = await ownerDb().whatsappIntegration.findUniqueOrThrow({ where: { businessId: s.businessId } });
      expect(row.isActive).toBe(false);
      expect((row.providerMetadata as Record<string, unknown>).zernioProfileId).toBe("profile-123");
    });

    it("reutiliza el perfil ya creado", async () => {
      await ownerDb().whatsappIntegration.create({
        data: { businessId: s.businessId, provider: "zernio", providerMetadata: { zernioProfileId: "viejo" } }
      });
      const fetchMock = mockZernio({ "/connect/whatsapp": { url: "https://zernio.com/connect/xyz" } });

      const res = await request(app)
        .post("/v1/whatsapp/connect/start")
        .set(bearer(s.owner))
        .send({ redirectUrl: "https://app.toki.ar/x" })
        .expect(200);

      expect(res.body.profileId).toBe("viejo");
      expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/profiles"))).toBe(true);
    });

    it("rechaza una URL de retorno inválida", async () => {
      await request(app)
        .post("/v1/whatsapp/connect/start")
        .set(bearer(s.owner))
        .send({ redirectUrl: "no-es-una-url" })
        .expect(400);
    });

    it("no pisa una integración legacy de Meta", async () => {
      await ownerDb().whatsappIntegration.create({ data: { businessId: s.businessId, provider: "meta" } });
      const res = await request(app)
        .post("/v1/whatsapp/connect/start")
        .set(bearer(s.owner))
        .send({ redirectUrl: "https://app.toki.ar/x" })
        .expect(409);
      expect(res.body.error.message).toMatch(/legacy/i);
    });

    it("completa la conexión y la activa", async () => {
      await ownerDb().whatsappIntegration.create({
        data: { businessId: s.businessId, provider: "zernio", providerMetadata: { zernioProfileId: "profile-123" } }
      });
      const res = await request(app)
        .post("/v1/whatsapp/connect/complete")
        .set(bearer(s.owner))
        .send({ profileId: "profile-123", accountId: "cuenta-9", username: "+543815550000" })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.integration).toMatchObject({ isActive: true, phoneNumber: "+543815550000" });
      const row = await ownerDb().whatsappIntegration.findUniqueOrThrow({ where: { businessId: s.businessId } });
      expect(row.providerExternalId).toBe("cuenta-9");
    });

    it("rechaza completar con otro perfil", async () => {
      await ownerDb().whatsappIntegration.create({
        data: { businessId: s.businessId, provider: "zernio", providerMetadata: { zernioProfileId: "profile-123" } }
      });
      const res = await request(app)
        .post("/v1/whatsapp/connect/complete")
        .set(bearer(s.owner))
        .send({ profileId: "otro", accountId: "cuenta-9" })
        .expect(409);
      expect(res.body.error.message).toMatch(/no coincide/i);
    });
  });

  describe("inbox", () => {
    it("lista las conversaciones del negocio", async () => {
      const res = await request(app).get("/v1/conversations").set(bearer(s.owner)).expect(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({ contactId: "contacto-1", status: "open" });
    });

    it("el staff también ve el inbox", async () => {
      const res = await request(app).get("/v1/conversations").set(bearer(s.staff)).expect(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("no ve las conversaciones de otro negocio", async () => {
      const otro = await seedShop("wa-otro");
      const res = await request(app).get("/v1/conversations").set(bearer(otro.owner)).expect(200);
      expect(res.body.data).toHaveLength(0);
    });

    it("trae los mensajes y el último pedido del cliente", async () => {
      await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send({
          customer: { name: "Ana", phone: "3815550001" },
          orderType: "takeaway",
          paymentMethod: "cash",
          items: [{ productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId] }]
        })
        .expect(201);

      const res = await request(app)
        .get(`/v1/conversations/${conversationId}/messages`)
        .set(bearer(s.owner))
        .expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.lastOrder).toMatchObject({ status: "pending", total: 10000 });
    });

    it("404 si la conversación es de otro negocio", async () => {
      const otro = await seedShop("wa-otro-2");
      await request(app).get(`/v1/conversations/${conversationId}/messages`).set(bearer(otro.owner)).expect(404);
    });

    it("al tomar la conversación queda en handoff con motivo", async () => {
      const res = await request(app)
        .patch(`/v1/conversations/${conversationId}/status`)
        .set(bearer(s.owner))
        .send({ status: "handoff" })
        .expect(200);
      expect(res.body).toMatchObject({ status: "handoff", handoffReason: "pedido_humano" });
    });

    it("al devolverla al bot se limpia el motivo", async () => {
      await ownerDb().whatsappConversation.update({
        where: { id: conversationId },
        data: { status: "handoff", handoffReason: "no_entiendo" }
      });
      const res = await request(app)
        .patch(`/v1/conversations/${conversationId}/status`)
        .set(bearer(s.owner))
        .send({ status: "open" })
        .expect(200);
      expect(res.body).toMatchObject({ status: "open", handoffReason: null });
    });
  });
});
