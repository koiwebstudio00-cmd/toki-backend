// Invitaciones del panel de admin: una activa por email, listado paginado de a 30 y reactivación.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Secret, TOTP } from "otpauth";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { createAdminActivation } from "../src/modules/admin/activation.js";
import { DB_AVAILABLE, ownerDb, seedShop } from "./helpers.js";

const app = buildApp();
const EMAIL = "platform-admin@toki.test";
const PASSWORD = "administracion-segura";
const DAY_MS = 86_400_000;

async function adminToken(): Promise<string> {
  const activation = await createAdminActivation(EMAIL);
  const token = new URLSearchParams(new URL(activation.url).hash.slice(1)).get("token")!;
  const start = await request(app).post("/v1/admin/activation/start").send({ token, fullName: "Administración", password: PASSWORD }).expect(200);
  const totp = new TOTP({ secret: Secret.fromBase32(start.body.secret) });
  const confirm = await request(app).post("/v1/admin/activation/confirm").send({ setupToken: start.body.setupToken, code: totp.generate() }).expect(200);
  return confirm.body.accessToken as string;
}

describe.runIf(DB_AVAILABLE)("invitaciones (admin)", () => {
  beforeEach(async () => { await seedShop(); });
  afterAll(async () => { await disconnectDb(); });

  it("exige sesión de admin para listar", async () => {
    await request(app).get("/v1/admin/invitations").expect(401);
  });

  it("generar otra invitación para el mismo email revoca la activa", async () => {
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };
    const first = await request(app).post("/v1/admin/invitations").set(auth).send({ email: "cliente@test.com" }).expect(201);
    expect(first.body.replaced).toBe(0);

    const second = await request(app).post("/v1/admin/invitations").set(auth).send({ email: "cliente@test.com" }).expect(201);
    expect(second.body.replaced).toBe(1);

    const previous = await ownerDb().signupInvitation.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(previous.revokedAt).not.toBeNull();
    expect(await ownerDb().signupInvitation.count({
      where: { email: "cliente@test.com", usedAt: null, revokedAt: null },
    })).toBe(1);
  });

  it("el listado va de a 30, de la más reciente a la más antigua, y la paginación recorre todas", async () => {
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };
    const now = Date.now();
    await ownerDb().signupInvitation.createMany({
      data: Array.from({ length: 35 }, (_, index) => ({
        email: `cliente-${index}@test.com`,
        codeHash: `hash-listado-${index}`,
        expiresAt: new Date(now + 7 * DAY_MS),
        createdAt: new Date(now - index * 60_000),
      })),
    });

    const first = await request(app).get("/v1/admin/invitations").set(auth).expect(200);
    expect(first.body.data).toHaveLength(30);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await request(app).get(`/v1/admin/invitations?cursor=${first.body.nextCursor}`).set(auth).expect(200);
    expect(second.body.data).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();

    const emails = [...first.body.data, ...second.body.data].map((invite: { email: string }) => invite.email);
    expect(emails).toEqual(Array.from({ length: 35 }, (_, index) => `cliente-${index}@test.com`));
  });

  it("reactivar una revocada genera una invitación nueva con su propio código", async () => {
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };
    const original = await request(app).post("/v1/admin/invitations").set(auth).send({ email: "reactivar@test.com" }).expect(201);
    await request(app).post(`/v1/admin/invitations/${original.body.id}/revoke`).set(auth).expect(200);

    const renewed = await request(app).post("/v1/admin/invitations").set(auth).send({ email: "reactivar@test.com" }).expect(201);
    expect(renewed.body.replaced).toBe(0);
    expect(renewed.body.code).toEqual(expect.any(String));
    expect(renewed.body.id).not.toBe(original.body.id);

    const list = await request(app).get("/v1/admin/invitations").set(auth).expect(200);
    expect(list.body.data.filter((invite: { email: string }) => invite.email === "reactivar@test.com")).toHaveLength(2);
  });
});
