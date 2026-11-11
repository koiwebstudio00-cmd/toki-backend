// Sesión recordada de Toki Admin (0027) y estadísticas del Resumen — docs/api.md.
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Secret, TOTP } from "otpauth";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { disconnectDb } from "../src/lib/db.js";
import { createAdminActivation } from "../src/modules/admin/activation.js";
import { DB_AVAILABLE, ownerDb, seedShop, truncateAll } from "./helpers.js";

const app = buildApp();
const previous = { ...config };
const EMAIL = "platform-admin@toki.test";
const PASSWORD = "administracion-segura";
const COOKIE = "toki_admin_session";

const cookieOf = (res: request.Response) => {
  const header = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find(item => item.startsWith(`${COOKIE}=`));
  return header ? header.split(";")[0]! : "";
};

async function activate() {
  const activation = await createAdminActivation(EMAIL);
  const token = new URLSearchParams(new URL(activation.url).hash.slice(1)).get("token")!;
  const start = await request(app).post("/v1/admin/activation/start").send({ token, fullName: "Administración", password: PASSWORD }).expect(200);
  const totp = new TOTP({ secret: Secret.fromBase32(start.body.secret) });
  const confirm = await request(app).post("/v1/admin/activation/confirm").send({ setupToken: start.body.setupToken, code: totp.generate() }).expect(200);
  return { totp, confirm, cookie: cookieOf(confirm) };
}

describe.runIf(DB_AVAILABLE)("sesión recordada de Toki Admin", () => {
  beforeEach(async () => {
    await truncateAll();
    Object.assign(config, { SUPERADMIN_EMAIL: EMAIL, ADMIN_FRONT_URL: "https://admin.toki.test", ADMIN_AUTH_ENCRYPTION_KEY: "7".repeat(64) });
  });
  afterEach(() => { Object.assign(config, previous); });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });

  it("la activación y el login dejan una cookie httpOnly de 30 días, guardada solo como hash", async () => {
    const { confirm, cookie, totp } = await activate();
    const header = ([] as string[]).concat(confirm.headers["set-cookie"] ?? []).join(";");
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\//);
    expect(confirm.body.rememberUntil).toBeTruthy();
    const days = (Date.parse(confirm.body.rememberUntil) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const stored = await ownerDb().adminRefreshToken.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(cookie.split("=")[1]);

    await ownerDb().user.updateMany({ where: { email: EMAIL }, data: { lastAdminTotpStep: null } });
    const login = await request(app).post("/v1/admin/session").send({ email: EMAIL, password: PASSWORD, code: totp.generate() }).expect(200);
    expect(cookieOf(login)).toMatch(/^toki_admin_session=[a-f0-9]{64}$/);
    expect(await ownerDb().adminRefreshToken.count({ where: { revokedAt: null } })).toBe(2);
  });

  it("renueva sin contraseña ni código, rota el token y conserva el vencimiento original", async () => {
    const { cookie, confirm } = await activate();
    await request(app).post("/v1/admin/session/refresh").expect(401);
    const refreshed = await request(app).post("/v1/admin/session/refresh").set("Cookie", cookie).expect(200);
    expect(refreshed.body.email).toBe(EMAIL);
    expect(refreshed.body.rememberUntil).toBe(confirm.body.rememberUntil);
    const next = cookieOf(refreshed);
    expect(next).not.toBe(cookie);
    await request(app).get("/v1/admin/overview").set("Authorization", `Bearer ${refreshed.body.accessToken}`).expect(200);
    // Una segunda pestaña con el token anterior, dentro de la ventana de gracia: rechazo sin cortar la sesión.
    await request(app).post("/v1/admin/session/refresh").set("Cookie", cookie).expect(401);
    await request(app).post("/v1/admin/session/refresh").set("Cookie", next).expect(200);
  });

  it("reusar un token rotado hace rato revoca todas las sesiones recordadas", async () => {
    const { cookie } = await activate();
    const refreshed = await request(app).post("/v1/admin/session/refresh").set("Cookie", cookie).expect(200);
    await ownerDb().adminRefreshToken.updateMany({ where: { revokedAt: { not: null } }, data: { revokedAt: new Date(Date.now() - 60_000) } });
    await request(app).post("/v1/admin/session/refresh").set("Cookie", cookie).expect(401);
    await request(app).post("/v1/admin/session/refresh").set("Cookie", cookieOf(refreshed)).expect(401);
  });

  it("cerrar sesión, vencer, recuperar la cuenta o cambiar la contraseña invalidan el dispositivo", async () => {
    let { cookie } = await activate();
    const logout = await request(app).post("/v1/admin/session/logout").set("Cookie", cookie).expect(200);
    expect(([] as string[]).concat(logout.headers["set-cookie"] ?? []).join(";")).toMatch(/toki_admin_session=;/);
    await request(app).post("/v1/admin/session/refresh").set("Cookie", cookie).expect(401);

    await truncateAll();
    ({ cookie } = await activate());
    await ownerDb().adminRefreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).post("/v1/admin/session/refresh").set("Cookie", cookie).expect(401);

    await truncateAll();
    ({ cookie } = await activate());
    await createAdminActivation(EMAIL, true);
    await request(app).post("/v1/admin/session/refresh").set("Cookie", cookie).expect(401);

    await truncateAll();
    ({ cookie } = await activate());
    await ownerDb().user.updateMany({ where: { email: EMAIL }, data: { adminSessionVersion: { increment: 1 } } });
    await request(app).post("/v1/admin/session/refresh").set("Cookie", cookie).expect(401);
  });

  it("un refresh del panel de negocios no sirve como cookie de Admin", async () => {
    await activate();
    const fake = "a".repeat(64);
    await request(app).post("/v1/admin/session/refresh").set("Cookie", `${COOKIE}=${fake}`).expect(401);
    await request(app).post("/v1/admin/session/refresh").set("Cookie", `${COOKIE}=no-es-hex`).expect(401);
  });

  it("el Resumen suma facturación sin cancelados, arma la serie diaria, el ranking y el embudo", async () => {
    // seedShop vacía la base: va antes de activar la cuenta administrativa.
    const shop = await seedShop("stats-shop");
    const { confirm } = await activate();
    for (const phone of ["3815550001", "3815550002", "3815550003"]) {
      await request(app).post(`/v1/public/businesses/${shop.slug}/orders`).send({
        customer: { name: "Cliente", phone }, orderType: "takeaway", paymentMethod: "cash",
        items: [{ productId: shop.burgerId, quantity: 1, optionValueIds: [shop.aPuntoId] }]
      }).expect(201);
    }
    const [first] = await ownerDb().order.findMany({ take: 1 });
    await ownerDb().order.update({ where: { id: first!.id }, data: { status: "cancelled" } });
    await ownerDb().signupInvitation.createMany({ data: [
      { email: "nuevo@toki.test", codeHash: "h1", expiresAt: new Date(Date.now() + 86_400_000) },
      { email: shop.owner.email, codeHash: "h2", expiresAt: new Date(Date.now() + 86_400_000), usedAt: new Date() },
    ] });

    const res = await request(app).get("/v1/admin/overview?days=7").set("Authorization", `Bearer ${confirm.body.accessToken}`).expect(200);
    const body = res.body;
    expect(body.orders).toBe(3);
    expect(body.revenue).toEqual([expect.objectContaining({ currency: "ARS", orders: 2, total: 20000, averageTicket: 10000, previousTotal: 0 })]);
    expect(body.previous).toEqual({ orders: 0, newUsers: 0, newBusinesses: 0 });
    expect(body.series).toHaveLength(7);
    expect(body.series.at(-1)).toEqual(expect.objectContaining({ orders: 3, revenue: { ARS: 20000 } }));
    expect(body.series.at(-1).businesses).toBeGreaterThanOrEqual(1);
    expect(body.topBusinesses[0]).toEqual(expect.objectContaining({ slug: "stats-shop", orders: 3, revenue: 20000 }));
    expect(body.businessActivity.withOrders).toBe(1);
    expect(body.invitations).toEqual({ created: 2, used: 1, verified: 1, withBusiness: 1, pending: 1, expired: 0, revoked: 0 });
    expect(JSON.stringify(body)).not.toMatch(/customerPhone|3815550001/);
  });
});
