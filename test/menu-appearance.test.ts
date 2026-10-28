import request from "supertest";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { withDb, disconnectDb } from "../src/lib/db.js";
import { defaultAppearance } from "../src/modules/menu-appearance/schemas.js";
import { bearer, seedTeam, DB_AVAILABLE, ownerDb, authCtx } from "./helpers.js";
const app = buildApp();
describe.runIf(DB_AVAILABLE)("menu appearance drafts and publication", () => {
  let team: Awaited<ReturnType<typeof seedTeam>>;
  beforeAll(async () => { team = await seedTeam(); });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });
  const read = () => request(app).get("/v1/business/menu-appearance").set(bearer(team.owner));
  it("defaults to Visual, persists draft without exposing it, publishes exact saved revision", async () => {
    const first = await read();
    expect(first.status).toBe(200); expect(first.body.draft).toEqual(defaultAppearance); expect(first.body.revision).toBe(0);
    const settings = { ...defaultAppearance, layout: "compact", color: "blue", cover: true };
    const saved = await request(app).put("/v1/business/menu-appearance/draft").set(bearer(team.owner)).send({ revision: 0, settings });
    expect(saved.status).toBe(200); expect(saved.body.revision).toBe(1);
    expect((await read()).body.draft).toEqual(settings);
    const before = await request(app).get("/v1/public/businesses/team-a");
    expect(before.body.business.menuAppearance).toEqual(defaultAppearance);
    expect(JSON.stringify(before.body)).not.toContain('"draft"');
    const published = await request(app).post("/v1/business/menu-appearance/publish").set(bearer(team.owner)).send({ revision: 1 });
    expect(published.status).toBe(200); expect(published.body.published).toEqual(settings); expect(published.body.revision).toBe(2);
    expect((await request(app).get("/v1/public/businesses/team-a")).body.business.menuAppearance).toEqual(settings);
    await request(app).put("/v1/business/menu-appearance/draft").set(bearer(team.owner)).send({ revision: 2, settings: { ...settings, layout: "categories" } }).expect(200);
    expect((await request(app).get("/v1/public/businesses/team-a")).body.business.menuAppearance.layout).toBe("compact");
  });
  it("rejects stale save and publish without changing either version", async () => {
    const before = (await read()).body;
    await request(app).put("/v1/business/menu-appearance/draft").set(bearer(team.owner)).send({ revision: 1, settings: defaultAppearance }).expect(409);
    await request(app).post("/v1/business/menu-appearance/publish").set(bearer(team.owner)).send({ revision: 1 }).expect(409);
    expect((await read()).body).toEqual(before);
  });
  it("rejects invalid layout, arbitrary styles, unknown properties, missing revision", async () => {
    for (const settings of [{ ...defaultAppearance, layout: "evil" }, { ...defaultAppearance, color: "url(javascript:x)" }, { ...defaultAppearance, html: "<script>" }]) {
      await request(app).put("/v1/business/menu-appearance/draft").set(bearer(team.owner)).send({ revision: 3, settings }).expect(400);
    }
    await request(app).post("/v1/business/menu-appearance/publish").set(bearer(team.owner)).send({}).expect(400);
  });
  it("enforces member reads, admin writes and tenant isolation in HTTP and RLS", async () => {
    await request(app).get("/v1/business/menu-appearance").expect(401);
    await request(app).get("/v1/business/menu-appearance").set(bearer(team.staff)).expect(200);
    await request(app).put("/v1/business/menu-appearance/draft").set(bearer(team.staff)).send({ revision: 3, settings: defaultAppearance }).expect(403);
    await request(app).post("/v1/business/menu-appearance/publish").set(bearer(team.staff)).send({ revision: 3 }).expect(403);
    await request(app).get("/v1/business/menu-appearance").set(bearer(team.other)).set("X-Business-Id", team.businessId).expect(403);
    expect((await request(app).get("/v1/business/menu-appearance").set(bearer(team.other))).body.draft).toEqual(defaultAppearance);
    const hidden = await withDb(authCtx(team.other), tx => tx.menuAppearanceDraft.findMany({ where: { businessId: team.businessId } }));
    expect(hidden).toEqual([]);
    const changed = await withDb(authCtx(team.staff), tx => tx.menuAppearanceDraft.updateMany({ where: { businessId: team.businessId }, data: { revision: 999 } }));
    expect(changed.count).toBe(0);
    await expect(withDb({ role: "anon" }, tx => tx.menuAppearanceDraft.findMany())).rejects.toBeDefined();
  });
  it("only one concurrent writer succeeds for a saved revision", async () => {
    const current = (await read()).body;
    const responses = await Promise.all(["visual", "categories"].map(layout => request(app).put("/v1/business/menu-appearance/draft").set(bearer(team.admin)).send({ revision: current.revision, settings: { ...defaultAppearance, layout } })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });
});
