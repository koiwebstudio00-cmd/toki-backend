import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { bearer, DB_AVAILABLE, ownerDb, seedTeam } from "./helpers.js";

const app = buildApp();

describe.runIf(DB_AVAILABLE)("settings, cupones y uploads", () => {
  let t: Awaited<ReturnType<typeof seedTeam>>;

  beforeAll(async () => {
    t = await seedTeam();
  });

  afterAll(async () => {
    await disconnectDb();
    await ownerDb().$disconnect();
  });

  describe("medios de pago", () => {
    it("sin fila devuelve defaults; PUT crea y actualiza", async () => {
      const def = await request(app).get("/v1/settings/payments").set(bearer(t.staff));
      expect(def.body).toMatchObject({ cashEnabled: true, transferEnabled: true, mercadopagoEnabled: false });

      const put = await request(app).put("/v1/settings/payments").set(bearer(t.admin)).send({
        cashEnabled: true,
        transferEnabled: true,
        transferCbu: "0000003100010000000001",
        transferAlias: " toki.demo ",
        transferHolder: "",
        transferBank: "Banco Macro"
      });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ transferAlias: "toki.demo", transferHolder: null, transferBank: "Banco Macro" });

      const again = await request(app).put("/v1/settings/payments").set(bearer(t.admin)).send({ cashEnabled: true, transferEnabled: false });
      expect(again.body).toMatchObject({ transferEnabled: false, transferCbu: null });
    });

    it("valida las reglas del front y bloquea Mercado Pago", async () => {
      const bad = [
        { cashEnabled: false, transferEnabled: false },
        { cashEnabled: false, transferEnabled: true },
        { cashEnabled: true, transferEnabled: true, transferCbu: "12ab" },
        { cashEnabled: true, transferEnabled: false, mercadopagoEnabled: true }
      ];
      for (const body of bad) {
        expect((await request(app).put("/v1/settings/payments").set(bearer(t.owner)).send(body)).status).toBe(400);
      }
      expect((await request(app).put("/v1/settings/payments").set(bearer(t.staff)).send({ cashEnabled: true, transferEnabled: false })).status).toBe(403);
    });
  });

  describe("fidelización", () => {
    it("defaults, upsert y validación", async () => {
      expect((await request(app).get("/v1/settings/loyalty").set(bearer(t.staff))).body).toMatchObject({ isEnabled: false, redeemRate: 10 });
      const body = { isEnabled: true, pointsPerCurrency: 0.05, pointsPerOrder: 10, redeemRate: 20, minPointsToRedeem: 50 };
      const res = await request(app).put("/v1/settings/loyalty").set(bearer(t.owner)).send(body);
      expect(res.body).toEqual(body);
      expect((await request(app).put("/v1/settings/loyalty").set(bearer(t.owner)).send({ ...body, redeemRate: 0 })).status).toBe(400);
    });
  });

  describe("bot y FAQs", () => {
    it("lee y edita la configuración del bot", async () => {
      const get = await request(app).get("/v1/settings/bot").set(bearer(t.staff));
      expect(get.body).toMatchObject({ isEnabled: true, botName: "Sofi" });
      const patch = await request(app).patch("/v1/settings/bot").set(bearer(t.admin)).send({ isEnabled: false, botName: "Tito" });
      expect(patch.body).toMatchObject({ isEnabled: false, botName: "Tito", handoffEnabled: true });
      expect((await request(app).patch("/v1/settings/bot").set(bearer(t.admin)).send({})).status).toBe(400);
    });

    it("CRUD de FAQs aislado por negocio", async () => {
      const created = await request(app).post("/v1/settings/bot/faqs").set(bearer(t.owner)).send({ question: "¿Hacen delivery?", answer: "Sí, en todo el centro." });
      expect(created.status).toBe(201);
      expect(created.body.isActive).toBe(true);

      const upd = await request(app).patch(`/v1/settings/bot/faqs/${created.body.id}`).set(bearer(t.owner)).send({ isActive: false });
      expect(upd.body.isActive).toBe(false);

      const otherFaq = await request(app).post("/v1/settings/bot/faqs").set(bearer(t.other)).send({ question: "¿Abren domingos?", answer: "No." });
      expect((await request(app).patch(`/v1/settings/bot/faqs/${otherFaq.body.id}`).set(bearer(t.owner)).send({ answer: "hack" })).status).toBe(404);

      const list = await request(app).get("/v1/settings/bot/faqs").set(bearer(t.staff));
      expect(list.body.data).toHaveLength(1);

      await request(app).delete(`/v1/settings/bot/faqs/${created.body.id}`).set(bearer(t.owner)).expect(204);
      expect((await request(app).post("/v1/settings/bot/faqs").set(bearer(t.staff)).send({ question: "¿Hola?", answer: "Hola" })).status).toBe(403);
    });
  });

  describe("cupones", () => {
    it("crea, normaliza el código y convierte montos", async () => {
      const res = await request(app).post("/v1/coupons").set(bearer(t.admin)).send({
        code: " verano-10 ",
        discountType: "percent",
        discountValue: 10,
        minimumOrderAmount: 5000,
        startsAt: "2026-12-01",
        endsAt: "2027-02-28",
        usageLimit: 100
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ code: "VERANO-10", discountValue: 10, minimumOrderAmount: 5000, usedCount: 0, isActive: true });
      expect(res.body.startsAt).toBe("2026-12-01T03:00:00.000Z");
    });

    it("409 con código repetido en el mismo negocio, OK en otro", async () => {
      expect((await request(app).post("/v1/coupons").set(bearer(t.owner)).send({ code: "VERANO-10", discountType: "fixed", discountValue: 500 })).status).toBe(409);
      expect((await request(app).post("/v1/coupons").set(bearer(t.other)).send({ code: "VERANO-10", discountType: "fixed", discountValue: 500 })).status).toBe(201);
    });

    it("valida porcentaje, fechas y códigos", async () => {
      const bad = [
        { code: "X1X", discountType: "percent", discountValue: 150 },
        { code: "FECHAS", discountType: "fixed", discountValue: 100, startsAt: "2027-01-10", endsAt: "2027-01-01" },
        { code: "con espacio", discountType: "fixed", discountValue: 100 },
        { code: "CERO", discountType: "fixed", discountValue: 0 }
      ];
      for (const body of bad) {
        expect((await request(app).post("/v1/coupons").set(bearer(t.owner)).send(body)).status).toBe(400);
      }
    });

    it("PATCH valida contra el estado final y DELETE respeta el negocio", async () => {
      const fixed = (await request(app).post("/v1/coupons").set(bearer(t.owner)).send({ code: "FIJO", discountType: "fixed", discountValue: 900 })).body;
      expect((await request(app).patch(`/v1/coupons/${fixed.id}`).set(bearer(t.owner)).send({ discountType: "percent" })).status).toBe(400);
      const ok = await request(app).patch(`/v1/coupons/${fixed.id}`).set(bearer(t.owner)).send({ discountValue: 1000, isActive: false });
      expect(ok.body).toMatchObject({ discountValue: 1000, isActive: false });

      const foreign = await ownerDb().coupon.findFirstOrThrow({ where: { businessId: t.otherBusinessId } });
      expect((await request(app).delete(`/v1/coupons/${foreign.id}`).set(bearer(t.owner))).status).toBe(404);
      expect(await ownerDb().coupon.count({ where: { id: foreign.id } })).toBe(1);

      expect((await request(app).get("/v1/coupons").set(bearer(t.owner))).body.data).toHaveLength(2);
      expect((await request(app).get("/v1/coupons").set(bearer(t.staff))).status).toBe(403);
      await request(app).delete(`/v1/coupons/${fixed.id}`).set(bearer(t.owner)).expect(204);
    });
  });

  describe("uploads", () => {
    it("firma una subida con key dentro del negocio", async () => {
      const res = await request(app).post("/v1/uploads/presign").set(bearer(t.admin)).send({ kind: "product", contentType: "image/webp" });
      expect(res.status).toBe(200);
      expect(res.body.key).toMatch(new RegExp(`^${t.businessId}/products/[0-9a-f-]{36}\\.webp$`));
      expect(res.body.publicUrl.endsWith(res.body.key)).toBe(true);
      expect(res.body).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/webp" }, expiresIn: 600 });

      // La URL devuelta se puede guardar en el producto.
      const prod = await request(app).post("/v1/products").set(bearer(t.admin)).send({ name: "Con foto", price: 100, imageUrl: res.body.publicUrl });
      expect(prod.status).toBe(201);
    });

    it("rechaza tipos no permitidos y a staff", async () => {
      expect((await request(app).post("/v1/uploads/presign").set(bearer(t.admin)).send({ kind: "product", contentType: "image/svg+xml" })).status).toBe(400);
      expect((await request(app).post("/v1/uploads/presign").set(bearer(t.admin)).send({ kind: "../otro", contentType: "image/png" })).status).toBe(400);
      expect((await request(app).post("/v1/uploads/presign").set(bearer(t.staff)).send({ kind: "product", contentType: "image/png" })).status).toBe(403);
    });
  });

  it("todas las rutas de negocio exigen sesión y negocio", async () => {
    const noBusiness = await import("./helpers.js").then((h) => h.createUser("sin-negocio-2@toki.test"));
    for (const path of ["/v1/business", "/v1/settings/payments", "/v1/coupons", "/v1/categories", "/v1/products", "/v1/ingredients", "/v1/business/checklist"]) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).set(bearer(noBusiness))).status).toBe(403);
    }
  });
});
