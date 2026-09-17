import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jwtSecret } from "../src/config.js";
import { disconnectDb } from "../src/lib/db.js";
import { requireApiKey } from "../src/middleware/apiKey.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAdmin, requireBusiness } from "../src/middleware/business.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error.js";
import { DB_AVAILABLE, ownerDb, seedTwoBusinesses, TEST_AGENT_KEY } from "./helpers.js";

// App mínima con las mismas cadenas de middlewares que usarán los módulos.
function testApp() {
  const app = express();
  app.use(express.json());
  app.get("/me", requireAuth, (req, res) => res.json(req.auth));
  app.get("/business", requireAuth, requireBusiness, (req, res) => res.json(req.business));
  app.post("/admin-only", requireAuth, requireBusiness, requireAdmin, (_req, res) => res.json({ ok: true }));
  app.get("/agent", requireApiKey, (req, res) => res.json({ agent: req.agent }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("requireAuth", () => {
  const app = testApp();

  it("401 sin header", async () => {
    const res = await request(app).get("/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("401 con token firmado con otro secreto", async () => {
    const bad = jwt.sign({ typ: "access", email: "x@x" }, "otro-secreto", { subject: "u", issuer: "toki-api" });
    const res = await request(app).get("/me").set("authorization", `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it("401 con token expirado", async () => {
    const expired = jwt.sign({ typ: "access", email: "x@x" }, jwtSecret, {
      subject: "u",
      issuer: "toki-api",
      expiresIn: -10
    });
    const res = await request(app).get("/me").set("authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("401 con un token que no es de acceso", async () => {
    const other = jwt.sign({ typ: "refresh" }, jwtSecret, { subject: "u", issuer: "toki-api" });
    const res = await request(app).get("/me").set("authorization", `Bearer ${other}`);
    expect(res.status).toBe(401);
  });
});

describe("requireApiKey", () => {
  const app = testApp();

  it("401 sin key y con key incorrecta", async () => {
    expect((await request(app).get("/agent")).status).toBe(401);
    expect((await request(app).get("/agent").set("x-api-key", "otra")).status).toBe(401);
  });

  it("200 con la key correcta", async () => {
    const res = await request(app).get("/agent").set("x-api-key", TEST_AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agent: true });
  });
});

describe.runIf(DB_AVAILABLE)("requireBusiness / requireRole", () => {
  const app = testApp();
  let s: Awaited<ReturnType<typeof seedTwoBusinesses>>;

  beforeAll(async () => {
    s = await seedTwoBusinesses();
  });

  afterAll(async () => {
    await disconnectDb();
    await ownerDb().$disconnect();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("resuelve el negocio y el rol del usuario", async () => {
    const res = await request(app).get("/business").set(auth(s.ownerA.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: s.businessA, role: "owner" });
  });

  it("acepta X-Business-Id de un negocio propio", async () => {
    const res = await request(app).get("/business").set(auth(s.staffA.token)).set("x-business-id", s.businessA);
    expect(res.body).toEqual({ id: s.businessA, role: "staff" });
  });

  it("403 con X-Business-Id de un negocio ajeno", async () => {
    const res = await request(app).get("/business").set(auth(s.ownerA.token)).set("x-business-id", s.businessB);
    expect(res.status).toBe(403);
  });

  it("400 con X-Business-Id mal formado", async () => {
    const res = await request(app).get("/business").set(auth(s.ownerA.token)).set("x-business-id", "1; drop");
    expect(res.status).toBe(400);
  });

  it("403 si el usuario todavía no tiene negocio", async () => {
    const { createUser } = await import("./helpers.js");
    const lonely = await createUser("sin-negocio@test.test");
    const res = await request(app).get("/business").set(auth(lonely.token));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/onboarding/);
  });

  it("requireAdmin: owner pasa, staff no", async () => {
    expect((await request(app).post("/admin-only").set(auth(s.ownerA.token))).status).toBe(200);
    const res = await request(app).post("/admin-only").set(auth(s.staffA.token));
    expect(res.status).toBe(403);
  });
});
