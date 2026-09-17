import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { testOutbox } from "../src/lib/mailer.js";
import { sha256 } from "../src/lib/tokens.js";
import { createBusiness, createUser, DB_AVAILABLE, ownerDb, truncateAll } from "./helpers.js";

const app = buildApp();
const PASSWORD = "clave-segura-1";

/** Saca el token del último email enviado a `to`. */
function tokenFromMail(to: string): string {
  const mail = [...testOutbox].reverse().find((m) => m.to === to);
  const match = mail?.text.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`No hay email con token para ${to}`);
  return match[1]!;
}

async function registerAndVerify(email: string, fullName = "Ana Pérez") {
  await request(app).post("/v1/auth/register").send({ fullName, email, password: PASSWORD }).expect(201);
  await request(app).post("/v1/auth/verify-email").send({ token: tokenFromMail(email) }).expect(200);
}

async function login(email: string, password = PASSWORD) {
  return request(app).post("/v1/auth/login").send({ email, password });
}

describe.runIf(DB_AVAILABLE)("auth", () => {
  beforeAll(async () => {
    await truncateAll();
  });

  beforeEach(() => {
    testOutbox.length = 0;
  });

  afterAll(async () => {
    await disconnectDb();
    await ownerDb().$disconnect();
  });

  describe("registro y verificación", () => {
    it("registra, crea el perfil y manda el email de verificación", async () => {
      const res = await request(app)
        .post("/v1/auth/register")
        .send({ fullName: "  Ana Pérez ", email: " Ana@Toki.TEST ", password: PASSWORD });
      expect(res.status).toBe(201);

      const user = await ownerDb().user.findUnique({ where: { email: "ana@toki.test" }, include: { profile: true } });
      expect(user?.emailVerifiedAt).toBeNull();
      expect(user?.passwordHash).not.toContain(PASSWORD);
      expect(user?.profile?.fullName).toBe("Ana Pérez");

      expect(testOutbox).toHaveLength(1);
      expect(testOutbox[0]!.subject).toMatch(/Confirmá tu email/);
      expect(testOutbox[0]!.text).toContain("http://localhost:5173/verify-email?token=");
      expect(testOutbox[0]!.html).toContain("Confirmar email");
    });

    it("en la BD solo queda el hash del token", async () => {
      await request(app).post("/v1/auth/register").send({ fullName: "Beto", email: "beto@toki.test", password: PASSWORD });
      const token = tokenFromMail("beto@toki.test");
      const rows = await ownerDb().emailToken.findMany({ where: { user: { email: "beto@toki.test" } } });
      expect(rows.map((r) => r.tokenHash)).toContain(sha256(token));
      expect(rows.some((r) => r.tokenHash === token)).toBe(false);
    });

    it("no deja entrar sin verificar, pero solo lo revela con la contraseña correcta", async () => {
      await request(app).post("/v1/auth/register").send({ fullName: "Caro", email: "caro@toki.test", password: PASSWORD });
      const wrong = await login("caro@toki.test", "otra-clave-1");
      expect(wrong.status).toBe(401);
      const right = await login("caro@toki.test");
      expect(right.status).toBe(403);
      expect(right.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    });

    it("verifica con el token y el token no se puede reusar", async () => {
      await request(app).post("/v1/auth/register").send({ fullName: "Dani", email: "dani@toki.test", password: PASSWORD });
      const token = tokenFromMail("dani@toki.test");
      await request(app).post("/v1/auth/verify-email").send({ token }).expect(200);
      const again = await request(app).post("/v1/auth/verify-email").send({ token });
      expect(again.status).toBe(400);
      expect((await login("dani@toki.test")).status).toBe(200);
    });

    it("rechaza tokens inventados o vencidos", async () => {
      expect((await request(app).post("/v1/auth/verify-email").send({ token: "a".repeat(64) })).status).toBe(400);

      await request(app).post("/v1/auth/register").send({ fullName: "Eva", email: "eva@toki.test", password: PASSWORD });
      const token = tokenFromMail("eva@toki.test");
      await ownerDb().emailToken.updateMany({ where: { tokenHash: sha256(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await request(app).post("/v1/auth/verify-email").send({ token })).status).toBe(400);
    });

    it("409 si el email ya tiene una cuenta verificada", async () => {
      await registerAndVerify("fede@toki.test");
      const res = await request(app).post("/v1/auth/register").send({ fullName: "Otro", email: "FEDE@toki.test", password: PASSWORD });
      expect(res.status).toBe(409);
    });

    it("re-registrar una cuenta sin verificar no pisa la contraseña e invalida el link anterior", async () => {
      await request(app).post("/v1/auth/register").send({ fullName: "Gabi", email: "gabi@toki.test", password: PASSWORD });
      const first = tokenFromMail("gabi@toki.test");
      await request(app).post("/v1/auth/register").send({ fullName: "Gabi", email: "gabi@toki.test", password: "otra-clave-9" }).expect(201);
      const second = tokenFromMail("gabi@toki.test");

      expect((await request(app).post("/v1/auth/verify-email").send({ token: first })).status).toBe(400);
      await request(app).post("/v1/auth/verify-email").send({ token: second }).expect(200);
      expect((await login("gabi@toki.test", "otra-clave-9")).status).toBe(401);
      expect((await login("gabi@toki.test")).status).toBe(200);
    });

    it("resend-verification responde igual exista o no, y solo manda email si hace falta", async () => {
      await request(app).post("/v1/auth/register").send({ fullName: "Hugo", email: "hugo@toki.test", password: PASSWORD });
      testOutbox.length = 0;
      const a = await request(app).post("/v1/auth/resend-verification").send({ email: "hugo@toki.test" });
      const b = await request(app).post("/v1/auth/resend-verification").send({ email: "nadie@toki.test" });
      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect(testOutbox.map((m) => m.to)).toEqual(["hugo@toki.test"]);
    });

    it("valida los datos de entrada", async () => {
      const res = await request(app).post("/v1/auth/register").send({ fullName: "A", email: "no-es-email", password: "corta" });
      expect(res.status).toBe(400);
      const fields = res.body.error.details.map((d: { field: string }) => d.field).sort();
      expect(fields).toEqual(["email", "fullName", "password"]);
    });
  });

  describe("sesiones", () => {
    const email = "sesion@toki.test";

    beforeAll(async () => {
      testOutbox.length = 0;
      await registerAndVerify(email, "Sole");
    });

    it("login devuelve tokens, usuario y negocios", async () => {
      const res = await login(email);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        expiresIn: 900,
        user: { email, fullName: "Sole", emailVerified: true },
        businesses: []
      });
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toMatch(/^[a-f0-9]{64}$/);
    });

    it("401 genérico con email inexistente o contraseña incorrecta", async () => {
      const a = await login("noexiste@toki.test");
      const b = await login(email, "incorrecta-1");
      expect(a.status).toBe(401);
      expect(b.body).toEqual(a.body);
    });

    it("refresh rota el token: el nuevo sirve y el viejo no", async () => {
      const { refreshToken } = (await login(email)).body;
      const r1 = await request(app).post("/v1/auth/refresh").send({ refreshToken });
      expect(r1.status).toBe(200);
      expect(r1.body.refreshToken).not.toBe(refreshToken);

      const reuse = await request(app).post("/v1/auth/refresh").send({ refreshToken });
      expect(reuse.status).toBe(401);
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: r1.body.refreshToken })).status).toBe(200);
    });

    it("reusar un token rotado hace rato revoca todas las sesiones", async () => {
      const { refreshToken } = (await login(email)).body;
      const other = (await login(email)).body.refreshToken;
      const rotated = await request(app).post("/v1/auth/refresh").send({ refreshToken });
      // Simula que la rotación fue hace más de la ventana de gracia.
      await ownerDb().refreshToken.updateMany({
        where: { tokenHash: sha256(refreshToken) },
        data: { revokedAt: new Date(Date.now() - 60_000) }
      });

      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken })).status).toBe(401);
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: rotated.body.refreshToken })).status).toBe(401);
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: other })).status).toBe(401);
    });

    it("refresh vencido no sirve", async () => {
      const { refreshToken } = (await login(email)).body;
      await ownerDb().refreshToken.updateMany({ where: { tokenHash: sha256(refreshToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken })).status).toBe(401);
    });

    it("logout revoca el refresh actual; con all revoca todos", async () => {
      const s1 = (await login(email)).body;
      const s2 = (await login(email)).body;
      await request(app).post("/v1/auth/logout").set("authorization", `Bearer ${s1.accessToken}`).send({ refreshToken: s1.refreshToken }).expect(200);
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: s1.refreshToken })).status).toBe(401);
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: s2.refreshToken })).status).toBe(200);

      const s3 = (await login(email)).body;
      await request(app).post("/v1/auth/logout").set("authorization", `Bearer ${s3.accessToken}`).send({ all: true }).expect(200);
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: s3.refreshToken })).status).toBe(401);
    });

    it("logout no permite revocar tokens de otro usuario", async () => {
      const victim = await createUser("victima@toki.test");
      const victimSession = (await login("victima@toki.test", "password123")).body;
      const attacker = (await login(email)).body;
      await request(app)
        .post("/v1/auth/logout")
        .set("authorization", `Bearer ${attacker.accessToken}`)
        .send({ refreshToken: victimSession.refreshToken })
        .expect(200);
      expect(victim.id).toBeTruthy();
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: victimSession.refreshToken })).status).toBe(200);
    });

    it("logout exige sesión", async () => {
      expect((await request(app).post("/v1/auth/logout").send({ all: true })).status).toBe(401);
    });
  });

  describe("recuperación de contraseña", () => {
    const email = "olvido@toki.test";

    beforeAll(async () => {
      testOutbox.length = 0;
      await registerAndVerify(email);
    });

    it("forgot responde igual exista o no, y solo manda email si existe", async () => {
      const a = await request(app).post("/v1/auth/forgot-password").send({ email });
      const b = await request(app).post("/v1/auth/forgot-password").send({ email: "nadie@toki.test" });
      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect(testOutbox.map((m) => m.to)).toEqual([email]);
      expect(testOutbox[0]!.text).toContain("/reset-password?token=");
    });

    it("reset cambia la contraseña, revoca sesiones y el link no se reusa", async () => {
      const session = (await login(email)).body;
      await request(app).post("/v1/auth/forgot-password").send({ email });
      const token = tokenFromMail(email);

      await request(app).post("/v1/auth/reset-password").send({ token, password: "nueva-clave-1" }).expect(200);
      expect((await login(email)).status).toBe(401);
      expect((await login(email, "nueva-clave-1")).status).toBe(200);
      expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: session.refreshToken })).status).toBe(401);
      expect((await request(app).post("/v1/auth/reset-password").send({ token, password: "otra-clave-2" })).status).toBe(400);
    });

    it("pedir un link nuevo invalida el anterior", async () => {
      await request(app).post("/v1/auth/forgot-password").send({ email });
      const first = tokenFromMail(email);
      await request(app).post("/v1/auth/forgot-password").send({ email });
      expect((await request(app).post("/v1/auth/reset-password").send({ token: first, password: "x-clave-123" })).status).toBe(400);
    });

    it("un token de verificación no sirve para resetear", async () => {
      await request(app).post("/v1/auth/register").send({ fullName: "Ivo", email: "ivo@toki.test", password: PASSWORD });
      const verifyToken = tokenFromMail("ivo@toki.test");
      expect((await request(app).post("/v1/auth/reset-password").send({ token: verifyToken, password: "x-clave-123" })).status).toBe(400);
    });

    it("resetear verifica el email de una cuenta pendiente", async () => {
      await request(app).post("/v1/auth/register").send({ fullName: "Juli", email: "juli@toki.test", password: PASSWORD });
      await request(app).post("/v1/auth/forgot-password").send({ email: "juli@toki.test" });
      await request(app).post("/v1/auth/reset-password").send({ token: tokenFromMail("juli@toki.test"), password: "nueva-clave-1" }).expect(200);
      expect((await login("juli@toki.test", "nueva-clave-1")).status).toBe(200);
    });
  });

  describe("me y perfil", () => {
    it("me devuelve perfil, negocios y negocio actual", async () => {
      const owner = await createUser("owner-me@toki.test", { fullName: "Owner Me" });
      const businessId = await createBusiness(owner, "negocio-me");
      const second = await createBusiness(owner, "negocio-me-2");

      const res = await request(app).get("/v1/auth/me").set("authorization", `Bearer ${owner.token}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: owner.id, email: owner.email, emailVerified: true });
      expect(res.body.profile.fullName).toBe("Owner Me");
      expect(res.body.businesses.map((b: { slug: string }) => b.slug)).toEqual(["negocio-me", "negocio-me-2"]);
      expect(res.body.currentBusiness).toMatchObject({ id: businessId, role: "owner" });

      const withHeader = await request(app).get("/v1/auth/me").set("authorization", `Bearer ${owner.token}`).set("x-business-id", second);
      expect(withHeader.body.currentBusiness.id).toBe(second);
    });

    it("login incluye los negocios del usuario", async () => {
      await registerAndVerify("con-negocio@toki.test");
      const session = (await login("con-negocio@toki.test")).body;
      await request(app)
        .get("/v1/auth/me")
        .set("authorization", `Bearer ${session.accessToken}`)
        .expect(200);
      const user = await ownerDb().user.findUniqueOrThrow({ where: { email: "con-negocio@toki.test" } });
      await createBusiness({ id: user.id, email: user.email, token: session.accessToken }, "negocio-login");
      const again = (await login("con-negocio@toki.test")).body;
      expect(again.businesses).toEqual([
        expect.objectContaining({ slug: "negocio-login", role: "owner", isActive: true })
      ]);
    });

    it("GET y PATCH /me/profile", async () => {
      const u = await createUser("perfil@toki.test", { fullName: "Perfil Uno" });
      const auth = { authorization: `Bearer ${u.token}` };

      const get = await request(app).get("/v1/me/profile").set(auth);
      expect(get.body).toEqual({ fullName: "Perfil Uno", phone: null, avatarUrl: null, email: "perfil@toki.test" });

      const patch = await request(app).patch("/v1/me/profile").set(auth).send({ fullName: "Perfil Dos", phone: " 381 555 1234 " });
      expect(patch.status).toBe(200);
      expect(patch.body).toMatchObject({ fullName: "Perfil Dos", phone: "381 555 1234" });

      const clear = await request(app).patch("/v1/me/profile").set(auth).send({ phone: "" });
      expect(clear.body.phone).toBeNull();

      expect((await request(app).patch("/v1/me/profile").set(auth).send({})).status).toBe(400);
      expect((await request(app).patch("/v1/me/profile").set(auth).send({ phone: "1".repeat(41) })).status).toBe(400);
    });

    it("el perfil de otro usuario no se puede tocar (RLS)", async () => {
      const a = await createUser("perfil-a@toki.test", { fullName: "A" });
      const b = await createUser("perfil-b@toki.test", { fullName: "B" });
      await request(app).patch("/v1/me/profile").set("authorization", `Bearer ${a.token}`).send({ fullName: "Cambio A" }).expect(200);
      const profileB = await ownerDb().profile.findUnique({ where: { id: b.id } });
      expect(profileB?.fullName).toBe("B");
    });

    it("sin sesión: 401", async () => {
      expect((await request(app).get("/v1/auth/me")).status).toBe(401);
      expect((await request(app).get("/v1/me/profile")).status).toBe(401);
    });
  });
});
