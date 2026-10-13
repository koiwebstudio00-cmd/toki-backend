import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { bearer, DB_AVAILABLE, ownerDb, seedTeam } from "./helpers.js";

const app = buildApp();

describe.runIf(DB_AVAILABLE)("catálogo paginado del POS", () => {
  let team: Awaited<ReturnType<typeof seedTeam>>;
  let categoryId: string;
  beforeAll(async () => {
    team = await seedTeam();
    const category = await ownerDb().category.create({ data: { businessId: team.businessId, name: "Bebidas" } });
    categoryId = category.id;
    await ownerDb().product.createMany({ data: Array.from({ length: 35 }, (_, index) => ({
      businessId: team.businessId, categoryId: index >= 30 ? categoryId : null,
      name: `Producto ${String(index).padStart(2, "0")}`, price: 1234.56,
      barcode: `POS-${index}`, sortOrder: index, trackStock: false,
      isAvailable: index !== 34
    })) });
    await ownerDb().product.create({ data: { businessId: team.otherBusinessId, name: "Producto ajeno", barcode: "POS-OTHER", price: 1 } });
  });
  afterAll(async () => { await disconnectDb(); await ownerDb().$disconnect(); });

  it("trae 16 por tanda, sin duplicados y termina sin una página extra", async () => {
    const first = await request(app).get("/v1/products/pos").set(bearer(team.staff)).expect(200);
    expect(first.body.data).toHaveLength(16);
    expect(first.body.nextOffset).toBe(16);
    const second = await request(app).get("/v1/products/pos?offset=16").set(bearer(team.staff)).expect(200);
    expect(second.body.data).toHaveLength(16);
    expect(second.body.nextOffset).toBe(32);
    const last = await request(app).get("/v1/products/pos?offset=32").set(bearer(team.staff)).expect(200);
    expect(last.body.data).toHaveLength(2);
    expect(last.body.nextOffset).toBeNull();
    const all = [...first.body.data, ...second.body.data, ...last.body.data];
    expect(new Set(all.map(p => p.id)).size).toBe(34);
    expect(all.map(p => p.name)).not.toContain("Producto ajeno");
    expect(first.body.data[0]).toMatchObject({ price: 1234.56, trackStock: false });
    // The old list keeps its original contract for other screens.
    const legacy = await request(app).get("/v1/products?available=true").set(bearer(team.owner)).expect(200);
    expect(legacy.body.data).toHaveLength(34);
  });

  it("busca en todo el catálogo y filtra antes de paginar", async () => {
    const search = await request(app).get("/v1/products/pos?search=producto%2033").set(bearer(team.staff)).expect(200);
    expect(search.body.data.map((p: { name: string }) => p.name)).toEqual(["Producto 33"]);
    const barcode = await request(app).get("/v1/products/pos?search=pos-33").set(bearer(team.staff)).expect(200);
    expect(barcode.body.data).toHaveLength(1);
    const category = await request(app).get(`/v1/products/pos?categoryId=${categoryId}&limit=2`).set(bearer(team.staff)).expect(200);
    expect(category.body.data.map((p: { name: string }) => p.name)).toEqual(["Producto 30", "Producto 31"]);
    expect(category.body.nextOffset).toBe(2);
    const empty = await request(app).get("/v1/products/pos?search=ausente").set(bearer(team.staff)).expect(200);
    expect(empty.body).toEqual({ data: [], nextOffset: null });
    // Exact barcode lookup for a scanner must also find an unloaded product.
    const scan = await request(app).get("/v1/products?barcode=pos-33&available=true").set(bearer(team.staff)).expect(200);
    expect(scan.body.data[0].id).toBe(search.body.data[0].id);
  });

  it("requiere sesión, limita el tamaño y aísla negocios", async () => {
    await request(app).get("/v1/products/pos").expect(401);
    for (const query of ["limit=17", "offset=-1", "offset=1.5", "limit=0", "limit=abc", "categoryId=invalid"]) {
      await request(app).get(`/v1/products/pos?${query}`).set(bearer(team.owner)).expect(400);
    }
    const other = await request(app).get(`/v1/products/pos?categoryId=${categoryId}`).set(bearer(team.other)).expect(200);
    expect(other.body.data).toEqual([]);
    await request(app).get("/v1/products/pos").set(bearer(team.staff)).set("x-business-id", team.otherBusinessId).expect(403);
  });
});
