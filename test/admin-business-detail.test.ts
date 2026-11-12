// Detalle de negocios, usuarios y pedidos del panel de admin, y filtro de WhatsApp (F1).
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Secret, TOTP } from "otpauth";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { disconnectDb } from "../src/lib/db.js";
import { createAdminActivation } from "../src/modules/admin/activation.js";
import { DB_AVAILABLE, ownerDb, seedShop, seedTwoBusinesses } from "./helpers.js";

const app = buildApp();
const previous = { ...config };
const EMAIL = "platform-admin@toki.test";
const PASSWORD = "administracion-segura";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
// Campos que nunca deben salir por la API de admin.
const SECRET_FIELDS = ["accessTokenEncrypted", "verifyToken", "providerMetadata", "adminTotpSecretEncrypted",
  "adminSessionVersion", "lastAdminTotpStep", "passwordHash", "storagePath"];

async function adminToken(): Promise<string> {
  const activation = await createAdminActivation(EMAIL);
  const token = new URLSearchParams(new URL(activation.url).hash.slice(1)).get("token")!;
  const start = await request(app).post("/v1/admin/activation/start").send({ token, fullName: "Administración", password: PASSWORD }).expect(200);
  const totp = new TOTP({ secret: Secret.fromBase32(start.body.secret) });
  const confirm = await request(app).post("/v1/admin/activation/confirm").send({ setupToken: start.body.setupToken, code: totp.generate() }).expect(200);
  return confirm.body.accessToken as string;
}

/** Pedido mínimo con un ítem, creado directamente en la base de prueba. */
async function seedOrder(businessId: string, orderCode: string, customerPhone: string) {
  return ownerDb().order.create({
    data: {
      businessId, orderCode, customerName: "Ana Pérez", customerPhone, deliveryAddress: "Calle falsa 123",
      subtotal: 1000, total: 1000, source: "web",
      items: { create: [{ businessId, productName: "Doble cheddar", quantity: 2, unitPrice: 500, totalPrice: 1000 }] },
    },
  });
}

describe.runIf(DB_AVAILABLE)("detalle de negocios, usuarios y pedidos (admin)", () => {
  let token = "";

  // Los seeds vacían auth.users, así que el admin se activa siempre después del seed.
  beforeEach(() => {
    Object.assign(config, { SUPERADMIN_EMAIL: EMAIL, ADMIN_FRONT_URL: "https://admin.toki.test", ADMIN_AUTH_ENCRYPTION_KEY: "7".repeat(64) });
  });
  afterEach(() => { Object.assign(config, previous); });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });

  it("exige sesión de admin para el detalle", async () => {
    await seedShop("detalle-sesion");
    token = await adminToken();
    const business = await ownerDb().business.findFirstOrThrow({ where: { slug: "detalle-sesion" } });
    await request(app).get(`/v1/admin/businesses/${business.id}`).expect(401);
    await request(app).get(`/v1/admin/users/${UNKNOWN_ID}`).expect(401);
    await request(app).get(`/v1/admin/orders/${UNKNOWN_ID}`).expect(401);
  });

  it("devuelve 404 para recursos inexistentes", async () => {
    await seedShop("detalle-404");
    token = await adminToken();
    await request(app).get(`/v1/admin/businesses/${UNKNOWN_ID}`).set("Authorization", `Bearer ${token}`).expect(404);
    await request(app).get(`/v1/admin/users/${UNKNOWN_ID}`).set("Authorization", `Bearer ${token}`).expect(404);
    await request(app).get(`/v1/admin/orders/${UNKNOWN_ID}`).set("Authorization", `Bearer ${token}`).expect(404);
  });

  it("detalle de negocio: equipo, actividad y WhatsApp sin conectar, sin secretos", async () => {
    await seedShop("detalle-negocio");
    token = await adminToken();
    const business = await ownerDb().business.findFirstOrThrow({ where: { slug: "detalle-negocio" } });
    await seedOrder(business.id, "TK-000001", "+5493814001234");
    const res = await request(app).get(`/v1/admin/businesses/${business.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.slug).toBe("detalle-negocio");
    expect(res.body.members.map((m: { role: string }) => m.role).sort()).toEqual(["owner", "staff"]);
    expect(res.body.stats.orders30d).toBe(1);
    expect(res.body.stats.revenue30d).toBe(1000);
    expect(res.body.whatsapp).toMatchObject({ status: "none", provider: null, phoneNumber: null, conversationsLast7d: 0 });
    expect(res.body.recentOrders).toHaveLength(1);
    const raw = JSON.stringify(res.body);
    for (const field of SECRET_FIELDS) expect(raw).not.toContain(field);
  });

  it("estado de WhatsApp: pendiente cuando la conexión no se completó, conectado cuando está activa", async () => {
    await seedShop("detalle-wa");
    token = await adminToken();
    const business = await ownerDb().business.findFirstOrThrow({ where: { slug: "detalle-wa" } });
    await ownerDb().whatsappIntegration.create({
      data: { businessId: business.id, provider: "zernio", isActive: false, phoneNumber: "+5493814000000", providerMetadata: { zernioProfileId: "p-1" } },
    });
    const pending = await request(app).get(`/v1/admin/businesses/${business.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(pending.body.whatsapp).toMatchObject({ status: "pending", provider: "zernio", phoneNumber: "+5493814000000" });
    expect(JSON.stringify(pending.body)).not.toContain("zernioProfileId");

    await ownerDb().whatsappIntegration.update({ where: { businessId: business.id }, data: { isActive: true } });
    const connected = await request(app).get(`/v1/admin/businesses/${business.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(connected.body.whatsapp.status).toBe("connected");
  });

  it("filtro ?whatsapp= del listado de negocios", async () => {
    const { businessA } = await seedTwoBusinesses();
    token = await adminToken();
    await ownerDb().whatsappIntegration.create({ data: { businessId: businessA, provider: "zernio", isActive: true, phoneNumber: "+5493814111111" } });

    const connected = await request(app).get("/v1/admin/businesses?whatsapp=connected").set("Authorization", `Bearer ${token}`).expect(200);
    expect(connected.body.data.map((row: { slug: string }) => row.slug)).toEqual(["negocio-a"]);
    expect(connected.body.data[0].whatsapp).toMatchObject({ status: "connected", phoneNumber: "+5493814111111" });

    const none = await request(app).get("/v1/admin/businesses?whatsapp=none").set("Authorization", `Bearer ${token}`).expect(200);
    expect(none.body.data.map((row: { slug: string }) => row.slug)).toEqual(["negocio-b"]);
    expect(none.body.data[0].whatsapp.status).toBe("none");

    await request(app).get("/v1/admin/businesses?whatsapp=otra").set("Authorization", `Bearer ${token}`).expect(400);
  });

  it("detalle de usuario: negocios y rol, sin campos de administración", async () => {
    await seedShop("detalle-usuario");
    token = await adminToken();
    const owner = await ownerDb().user.findFirstOrThrow({ where: { email: "owner@detalle-usuario.test" } });
    const res = await request(app).get(`/v1/admin/users/${owner.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.email).toBe("owner@detalle-usuario.test");
    expect(res.body.businesses).toEqual([expect.objectContaining({ role: "owner" })]);
    const raw = JSON.stringify(res.body);
    for (const field of SECRET_FIELDS) expect(raw).not.toContain(field);
  });

  it("detalle de pedido: teléfono enmascarado, sin dirección", async () => {
    await seedShop("detalle-pedido");
    token = await adminToken();
    const business = await ownerDb().business.findFirstOrThrow({ where: { slug: "detalle-pedido" } });
    const order = await seedOrder(business.id, "TK-000002", "+5493814001234");
    const res = await request(app).get(`/v1/admin/orders/${order.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.customer).toEqual({ name: "Ana Pérez", phone: "•••• 1234" });
    expect(res.body.items).toEqual([expect.objectContaining({ productName: "Doble cheddar", quantity: 2, totalPrice: 1000 })]);
    expect(res.body.amounts.total).toBe(1000);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("+549381");
    expect(raw).not.toContain("Calle falsa");
    for (const field of SECRET_FIELDS) expect(raw).not.toContain(field);
  });
});
