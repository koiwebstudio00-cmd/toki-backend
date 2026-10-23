import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { createUser, DB_AVAILABLE, ownerDb, truncateAll } from "./helpers.js";
import { publicUrl, presignPut, deleteReplacedImage } from "../src/lib/r2.js";
vi.mock("../src/lib/r2.js", async (load) => ({
  ...await load<typeof import("../src/lib/r2.js")>(),
  presignPut: vi.fn().mockResolvedValue("https://storage.test/signed"),
  deleteReplacedImage: vi.fn().mockResolvedValue(undefined)
}));
const app = buildApp();
const photo = (userId: string) => publicUrl(`profiles/${userId}/avatar/${randomUUID()}.png`);
describe.runIf(DB_AVAILABLE)("avatar personal", () => {
  beforeEach(async () => { await truncateAll(); vi.clearAllMocks(); });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });
  it("firma una foto sin negocio y vincula tamaño, tipo y usuario", async () => {
    const u = await createUser("avatar@toki.test");
    const res = await request(app).post("/v1/me/avatar/presign").set("authorization", `Bearer ${u.token}`).send({ contentType: "image/png", size: 300 }).expect(200);
    expect(res.body.publicUrl).toContain(`/profiles/${u.id}/avatar/`);
    expect(presignPut).toHaveBeenCalledWith("public", expect.stringContaining(`profiles/${u.id}/avatar/`), "image/png", 300);
  });
  it("valida sesión, formato y tamaño antes de firmar", async () => {
    await request(app).post("/v1/me/avatar/presign").send({ contentType: "image/png", size: 300 }).expect(401);
    const u = await createUser("invalid@toki.test");
    for (const data of [{ contentType: "image/svg+xml", size: 300 }, { contentType: "image/png", size: 2097153 }, { contentType: "image/png", size: 0 }]) {
      await request(app).post("/v1/me/avatar/presign").set("authorization", `Bearer ${u.token}`).send(data).expect(400);
    }
    expect(presignPut).not.toHaveBeenCalled();
  });
  it("guarda, reemplaza y quita sin cambiar los demás datos; auth/me refleja la foto", async () => {
    const u = await createUser("profile@toki.test", { fullName: "Mi nombre" });
    const auth = { authorization: `Bearer ${u.token}` };
    const first = photo(u.id), second = photo(u.id);
    await request(app).patch("/v1/me/profile").set(auth).send({ phone: "123456789", avatarUrl: first }).expect(200);
    const me = await request(app).get("/v1/auth/me").set(auth).expect(200);
    expect(me.body.profile.avatarUrl).toBe(first);
    const changed = await request(app).patch("/v1/me/profile").set(auth).send({ avatarUrl: second }).expect(200);
    expect(changed.body).toMatchObject({ fullName: "Mi nombre", phone: "123456789", avatarUrl: second });
    expect(deleteReplacedImage).toHaveBeenCalledWith(first, second);
    const cleared = await request(app).patch("/v1/me/profile").set(auth).send({ avatarUrl: null }).expect(200);
    expect(cleared.body.avatarUrl).toBeNull();
    expect(deleteReplacedImage).toHaveBeenCalledWith(second, null);
  });
  it("rechaza fotos ajenas, URLs externas y rutas manipuladas sin cambiar perfiles", async () => {
    const a = await createUser("a@toki.test"), b = await createUser("b@toki.test");
    for (const url of [photo(b.id), "https://evil.test/avatar.png", publicUrl(`profiles/${a.id}/avatar/../other.png`), photo(a.id) + "?x=1", photo(a.id).replace("/avatar/", "/avatar/%2e%2e/")]) {
      await request(app).patch("/v1/me/profile").set("authorization", `Bearer ${a.token}`).send({ avatarUrl: url }).expect(400);
    }
    expect((await ownerDb().profile.findUnique({ where: { id: a.id } }))?.avatarUrl).toBeNull();
    expect((await ownerDb().profile.findUnique({ where: { id: b.id } }))?.avatarUrl).toBeNull();
    expect(deleteReplacedImage).not.toHaveBeenCalled();
  });
});
