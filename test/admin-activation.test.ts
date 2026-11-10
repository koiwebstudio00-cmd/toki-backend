import request from "supertest";
import { beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import { TOTP, Secret } from "otpauth";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { testOutbox } from "../src/lib/mailer.js";
import { disconnectDb, withDb } from "../src/lib/db.js";
import { verifyPassword } from "../src/lib/passwords.js";
import { createAdminActivation } from "../src/modules/admin/activation.js";
import { bearer, authCtx, createUser, createBusiness, DB_AVAILABLE, ownerDb, truncateAll } from "./helpers.js";

const app = buildApp();
const previous = { ...config };
const EMAIL = "platform-admin@toki.test";
const PASSWORD = "administracion-segura";
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("token")!;
const totpOf = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret) });
const wrongCode = (secret: string) => {
  const totp = totpOf(secret);
  for (let value = 0; value < 1_000_000; value++) {
    const code = String(value).padStart(6, "0");
    if (totp.validate({ token: code, window: 1 }) === null) return code;
  }
  throw new Error("No se encontró un código inválido.");
};
async function prepare() {
  const activation = await createAdminActivation(EMAIL);
  const token = tokenOf(activation.url);
  const start = await request(app).post("/v1/admin/activation/start").send({ token, fullName: "Koi Administración", password: PASSWORD }).expect(200);
  return { token, ...start.body } as { token: string; setupToken: string; secret: string; provisioningUri: string };
}
describe.runIf(DB_AVAILABLE)("activación administrativa independiente", () => {
  beforeEach(async () => {
    await truncateAll();
    Object.assign(config, { SUPERADMIN_EMAIL: EMAIL, ADMIN_FRONT_URL: "https://admin.toki.test", ADMIN_AUTH_ENCRYPTION_KEY: "7".repeat(64) });
  });
  afterEach(() => { Object.assign(config, previous); });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });

  it("activa una identidad compartida desde Admin con contraseña y QR, sin crear negocio ni invitación de cliente", async () => {
    const activation = await createAdminActivation(EMAIL);
    expect(new URL(activation.url).origin + new URL(activation.url).pathname).toBe("https://admin.toki.test/activar");
    expect(await ownerDb().signupInvitation.count()).toBe(0);
    expect(await ownerDb().businessMember.count()).toBe(0);
    const token = tokenOf(activation.url);
    await request(app).post("/v1/admin/activation/check").send({ token }).expect(200, { email: EMAIL });
    const start = await request(app).post("/v1/admin/activation/start").send({ token, fullName: "Koi Administración", password: PASSWORD }).expect(200);
    expect(start.body.provisioningUri).toContain("otpauth://totp/");
    expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    await request(app).post("/v1/admin/activation/check").send({ token }).expect(401);
    await request(app).post("/v1/admin/session").send({ email: EMAIL, password: PASSWORD, code: totpOf(start.body.secret).generate() }).expect(401);
    await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${start.body.setupToken}`).expect(401);
    const session = await request(app).post("/v1/admin/activation/confirm").send({ setupToken: start.body.setupToken, code: totpOf(start.body.secret).generate() }).expect(200);
    const user = await ownerDb().user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.adminAccessEnabled).toBe(true);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.adminTotpSecretEncrypted).not.toContain(start.body.secret);
    expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);
    await request(app).get("/v1/admin/overview").set("Authorization", `Bearer ${session.body.accessToken}`).expect(200);
    await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${session.body.accessToken}`).expect(401);
    await request(app).post("/v1/admin/activation/confirm").send({ setupToken: start.body.setupToken, code: totpOf(start.body.secret).generate() }).expect(401);
    const pending = await ownerDb().adminActivation.findFirstOrThrow();
    expect(pending.passwordHash).toBeNull();
    expect(pending.totpSecretEncrypted).toBeNull();
    expect(await ownerDb().businessMember.count()).toBe(0);
  });

  it("un enlace se intercambia una sola vez aunque se envíe simultáneamente", async () => {
    const activation = await createAdminActivation(EMAIL);
    const input = { token: tokenOf(activation.url), fullName: "Administración", password: PASSWORD };
    const responses = await Promise.all([request(app).post("/v1/admin/activation/start").send(input), request(app).post("/v1/admin/activation/start").send(input)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
  });

  it("limita los códigos incorrectos y no activa permisos antes de completar el autenticador", async () => {
    const setup = await prepare();
    for (let i = 0; i < 5; i++) await request(app).post("/v1/admin/activation/confirm").send({ setupToken: setup.setupToken, code: wrongCode(setup.secret) }).expect(401);
    await request(app).post("/v1/admin/activation/confirm").send({ setupToken: setup.setupToken, code: totpOf(setup.secret).generate() }).expect(401);
    expect((await ownerDb().user.findUniqueOrThrow({ where: { email: EMAIL } })).adminAccessEnabled).toBe(false);
  });

  it("rechaza enlaces vencidos y códigos de registro de clientes", async () => {
    const activation = await createAdminActivation(EMAIL);
    const token = tokenOf(activation.url);
    await ownerDb().adminActivation.updateMany({ data: { expiresAt: new Date(0) } });
    await request(app).post("/v1/admin/activation/check").send({ token }).expect(401);
    await request(app).post("/v1/auth/invitations/check").send({ invitationCode: token }).expect(400);
  });

  it("la recuperación interna invalida la sesión anterior y los enlaces pendientes", async () => {
    const setup = await prepare();
    const session = await request(app).post("/v1/admin/activation/confirm").send({ setupToken: setup.setupToken, code: totpOf(setup.secret).generate() }).expect(200);
    await expect(createAdminActivation(EMAIL)).rejects.toThrow(/ya está activa/);
    const next = await createAdminActivation(EMAIL, true);
    await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${session.body.accessToken}`).expect(403);
    await request(app).post("/v1/admin/activation/check").send({ token: tokenOf(next.url) }).expect(200);
    await request(app).post("/v1/admin/activation/confirm").send({ setupToken: setup.setupToken, code: totpOf(setup.secret).generate() }).expect(401);
  });

  it("cambiar la contraseña revoca también la sesión administrativa", async () => {
    const setup = await prepare();
    const session = await request(app).post("/v1/admin/activation/confirm").send({ setupToken: setup.setupToken, code: totpOf(setup.secret).generate() }).expect(200);
    await request(app).post("/v1/auth/forgot-password").send({ email: EMAIL }).expect(200);
    const mail = [...testOutbox].reverse().find(item => item.to === EMAIL && item.subject.includes("contraseña"));
    const resetToken = mail?.text.match(/token=([a-f0-9]{64})/)?.[1];
    expect(resetToken).toBeTruthy();
    await request(app).post("/v1/auth/reset-password").send({ token: resetToken, password: "otra-clave-segura" }).expect(200);
    await request(app).get("/v1/admin/users").set("Authorization", `Bearer ${session.body.accessToken}`).expect(403);
  });

  it("no promueve clientes, ni expone activaciones a una sesión normal o a otro negocio", async () => {
    const owner = await createUser(EMAIL);
    await createBusiness(owner, "ordinary-business");
    await expect(createAdminActivation(EMAIL)).rejects.toThrow(/cuenta administrativa dedicada/);
    expect((await ownerDb().user.findUniqueOrThrow({ where: { id: owner.id } })).adminAccessEnabled).toBe(false);
    const other = await createUser("other-owner@toki.test");
    await createBusiness(other, "other-business");
    await request(app).get("/v1/admin/users").set(bearer(other)).expect(401);
    await expect(withDb(authCtx(other), tx => tx.adminActivation.findMany())).rejects.toThrow();
    await expect(createAdminActivation("not-authorized@toki.test")).rejects.toThrow(/no coincide/);
  });
});
