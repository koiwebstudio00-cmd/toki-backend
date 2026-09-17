import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { publicUrl } from "../src/lib/r2.js";
import { bearer, DB_AVAILABLE, ownerDb, seedTeam } from "./helpers.js";

const app = buildApp();

const burger = (overrides: Record<string, unknown> = {}) => ({
  name: "Hamburguesa Clásica",
  description: "Con cheddar",
  price: 8500,
  stockQuantity: 20,
  lowStockThreshold: 5,
  isFeatured: true,
  options: [
    {
      name: "Punto",
      type: "single",
      isRequired: true,
      values: [{ name: "A punto" }, { name: "Bien cocida" }]
    },
    {
      name: "Extras",
      type: "multiple",
      maxSelect: 3,
      values: [
        { name: "Cheddar", priceDelta: 900, stockQuantity: 50 },
        { name: "Panceta", priceDelta: 1200, stockQuantity: 30 }
      ]
    }
  ],
  ...overrides
});

describe.runIf(DB_AVAILABLE)("catálogo", () => {
  let t: Awaited<ReturnType<typeof seedTeam>>;

  beforeAll(async () => {
    t = await seedTeam();
  });

  afterAll(async () => {
    await disconnectDb();
    await ownerDb().$disconnect();
  });

  describe("categorías", () => {
    it("CRUD, orden automático y conteo de productos", async () => {
      const a = await request(app).post("/v1/categories").set(bearer(t.admin)).send({ name: "Hamburguesas" });
      const b = await request(app).post("/v1/categories").set(bearer(t.admin)).send({ name: "Bebidas", description: "Frías" });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ name: "Hamburguesas", sortOrder: 1, isActive: true, description: "" });
      expect(b.body.sortOrder).toBe(2);

      await request(app).post("/v1/products").set(bearer(t.admin)).send(burger({ categoryId: a.body.id })).expect(201);

      const list = await request(app).get("/v1/categories").set(bearer(t.staff));
      expect(list.body.data.map((c: { name: string }) => c.name)).toEqual(["Hamburguesas", "Bebidas"]);
      expect(list.body.data[0]).toMatchObject({ products: 1, availableProducts: 1 });

      const paused = await request(app).patch(`/v1/categories/${b.body.id}`).set(bearer(t.owner)).send({ isActive: false });
      expect(paused.body.isActive).toBe(false);
      const active = await request(app).get("/v1/categories?active=true").set(bearer(t.staff));
      expect(active.body.data).toHaveLength(1);
    });

    it("reorder aplica el orden recibido", async () => {
      const list = (await request(app).get("/v1/categories").set(bearer(t.staff))).body.data;
      const ids = list.map((c: { id: string }) => c.id).reverse();
      const res = await request(app).patch("/v1/categories/reorder").set(bearer(t.owner)).send({ ids });
      expect(res.status).toBe(200);
      expect(res.body.data.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(res.body.data.map((c: { sortOrder: number }) => c.sortOrder)).toEqual([1, 2]);
    });

    it("reorder rechaza categorías ajenas", async () => {
      const foreign = await ownerDb().category.create({ data: { businessId: t.otherBusinessId, name: "Ajena" } });
      const res = await request(app).patch("/v1/categories/reorder").set(bearer(t.owner)).send({ ids: [foreign.id] });
      expect(res.status).toBe(400);
    });

    it("staff no puede crear, editar ni borrar", async () => {
      const cat = (await request(app).get("/v1/categories").set(bearer(t.staff))).body.data[0];
      expect((await request(app).post("/v1/categories").set(bearer(t.staff)).send({ name: "Nope" })).status).toBe(403);
      expect((await request(app).patch(`/v1/categories/${cat.id}`).set(bearer(t.staff)).send({ name: "Nope" })).status).toBe(403);
      expect((await request(app).delete(`/v1/categories/${cat.id}`).set(bearer(t.staff))).status).toBe(403);
    });

    it("una categoría de otro negocio da 404", async () => {
      const foreign = await ownerDb().category.findFirstOrThrow({ where: { businessId: t.otherBusinessId } });
      expect((await request(app).patch(`/v1/categories/${foreign.id}`).set(bearer(t.owner)).send({ name: "Otra" })).status).toBe(404);
      expect((await request(app).delete(`/v1/categories/${foreign.id}`).set(bearer(t.owner))).status).toBe(404);
    });

    it("borrar una categoría deja sus productos sin categoría", async () => {
      const cat = await request(app).post("/v1/categories").set(bearer(t.owner)).send({ name: "Temporal" });
      const prod = await request(app).post("/v1/products").set(bearer(t.owner)).send(burger({ name: "Temporal", categoryId: cat.body.id, options: [] }));
      await request(app).delete(`/v1/categories/${cat.body.id}`).set(bearer(t.owner)).expect(204);
      const after = await request(app).get(`/v1/products/${prod.body.id}`).set(bearer(t.owner));
      expect(after.body.categoryId).toBeNull();
    });

    it("id mal formado da 400", async () => {
      expect((await request(app).patch("/v1/categories/no-es-uuid").set(bearer(t.owner)).send({ name: "x" })).status).toBe(400);
    });
  });

  describe("productos", () => {
    it("crea el producto con opciones en una transacción y devuelve montos numéricos", async () => {
      const res = await request(app).post("/v1/products").set(bearer(t.admin)).send(burger({ newCategoryName: "Nueva categoría" }));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "Hamburguesa Clásica",
        price: 8500,
        trackStock: true,
        stockQuantity: 20,
        isLowStock: false,
        category: { name: "Nueva categoría" }
      });
      expect(res.body.barcode).toMatch(/^TKI-[0-9A-F]{10}$/);
      const [punto, extras] = res.body.options;
      expect(punto).toMatchObject({ type: "single", isRequired: true, minSelect: 1, maxSelect: 1, sortOrder: 1 });
      expect(extras).toMatchObject({ type: "multiple", isRequired: false, minSelect: 0, maxSelect: 3 });
      expect(extras.values[1]).toMatchObject({ name: "Panceta", priceDelta: 1200, stockQuantity: 30, sortOrder: 2 });
    });

    it("si falla una parte no queda nada a medias", async () => {
      const before = await ownerDb().product.count({ where: { businessId: t.businessId } });
      await request(app).post("/v1/products").set(bearer(t.admin)).send(burger({ name: "Con barcode", barcode: "DUP-0001", options: [] })).expect(201);
      const dup = await request(app).post("/v1/products").set(bearer(t.admin)).send(burger({ name: "Duplicado", barcode: "DUP-0001", newCategoryName: "No debería quedar" }));
      expect(dup.status).toBe(409);
      expect(await ownerDb().product.count({ where: { businessId: t.businessId } })).toBe(before + 1);
      expect(await ownerDb().category.count({ where: { businessId: t.businessId, name: "No debería quedar" } })).toBe(0);
    });

    it("el mismo barcode en otro negocio está permitido", async () => {
      const res = await request(app).post("/v1/products").set(bearer(t.other)).send(burger({ barcode: "DUP-0001", options: [] }));
      expect(res.status).toBe(201);
    });

    it("PUT sincroniza opciones conservando ids", async () => {
      const created = (await request(app).post("/v1/products").set(bearer(t.owner)).send(burger({ name: "Editable" }))).body;
      const [punto, extras] = created.options;
      const cheddar = extras.values[0];

      const body = burger({
        name: "Editable v2",
        price: 9000,
        options: [
          { id: extras.id, name: "Agregados", type: "multiple", maxSelect: 2, values: [{ id: cheddar.id, name: "Cheddar doble", priceDelta: 1500 }, { name: "Huevo", priceDelta: 700 }] }
        ]
      });
      const res = await request(app).put(`/v1/products/${created.id}`).set(bearer(t.owner)).send(body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Editable v2", price: 9000 });
      expect(res.body.options).toHaveLength(1);
      expect(res.body.options[0]).toMatchObject({ id: extras.id, name: "Agregados", maxSelect: 2 });
      expect(res.body.options[0].values.map((v: { name: string }) => v.name)).toEqual(["Cheddar doble", "Huevo"]);
      expect(res.body.options[0].values[0].id).toBe(cheddar.id);
      expect(await ownerDb().productOption.count({ where: { id: punto.id } })).toBe(0);
      expect(res.body.barcode).toBe(created.barcode);
    });

    it("no se pueden reutilizar ids de opciones de otro producto", async () => {
      const p1 = (await request(app).post("/v1/products").set(bearer(t.owner)).send(burger({ name: "P1" }))).body;
      const p2 = (await request(app).post("/v1/products").set(bearer(t.owner)).send(burger({ name: "P2", options: [] }))).body;
      const stolen = p1.options[0];
      const res = await request(app).put(`/v1/products/${p2.id}`).set(bearer(t.owner)).send(burger({ name: "P2", options: [{ ...stolen, values: stolen.values }] }));
      expect(res.status).toBe(200);
      expect(res.body.options[0].id).not.toBe(stolen.id);
      const p1After = await request(app).get(`/v1/products/${p1.id}`).set(bearer(t.owner));
      expect(p1After.body.options).toHaveLength(2);
    });

    it("filtros: disponibles, búsqueda, barcode, categoría y stock bajo", async () => {
      const cat = (await request(app).post("/v1/categories").set(bearer(t.owner)).send({ name: "Postres" })).body;
      const flan = (await request(app).post("/v1/products").set(bearer(t.owner)).send(burger({ name: "Flan casero", categoryId: cat.id, barcode: "FLAN-123", stockQuantity: 2, lowStockThreshold: 5, options: [] }))).body;
      await request(app).patch(`/v1/products/${flan.id}/availability`).set(bearer(t.owner)).send({ isAvailable: false }).expect(200);

      const q = (qs: string) => request(app).get(`/v1/products?${qs}`).set(bearer(t.staff)).then((r) => r.body.data.map((p: { name: string }) => p.name));
      expect(await q("search=FLAN")).toEqual(["Flan casero"]);
      expect(await q("barcode=FLAN-123")).toEqual(["Flan casero"]);
      expect(await q("search=flan-123")).toEqual(["Flan casero"]);
      expect(await q(`categoryId=${cat.id}`)).toEqual(["Flan casero"]);
      expect(await q("available=false")).toEqual(["Flan casero"]);
      expect(await q("lowStock=true")).toContain("Flan casero");
      expect(await q("available=true")).not.toContain("Flan casero");
    });

    it("stock y disponibilidad por PATCH; staff no puede", async () => {
      const p = (await request(app).post("/v1/products").set(bearer(t.owner)).send(burger({ name: "Stock", options: [] }))).body;
      const res = await request(app).patch(`/v1/products/${p.id}/stock`).set(bearer(t.admin)).send({ stockQuantity: 3 });
      expect(res.body).toMatchObject({ stockQuantity: 3, isLowStock: true });
      expect((await request(app).patch(`/v1/products/${p.id}/stock`).set(bearer(t.admin)).send({ stockQuantity: -1 })).status).toBe(400);
      expect((await request(app).patch(`/v1/products/${p.id}/stock`).set(bearer(t.staff)).send({ stockQuantity: 9 })).status).toBe(403);
    });

    it("valida entrada: precio, opciones sin valores, categoría ajena, imagen ajena", async () => {
      const foreignCat = await ownerDb().category.create({ data: { businessId: t.otherBusinessId, name: "Ajena 2" } });
      const cases = [
        burger({ price: -1 }),
        burger({ options: [{ name: "Vacío", type: "single", values: [] }] }),
        burger({ categoryId: foreignCat.id }),
        burger({ imageUrl: publicUrl(`${t.otherBusinessId}/products/x.webp`) }),
        burger({ categoryId: foreignCat.id, newCategoryName: "Las dos" })
      ];
      for (const body of cases) {
        expect((await request(app).post("/v1/products").set(bearer(t.owner)).send(body)).status).toBe(400);
      }
      const ok = await request(app).post("/v1/products").set(bearer(t.owner)).send(burger({ name: "Con imagen", imageUrl: publicUrl(`${t.businessId}/products/x.webp`), options: [] }));
      expect(ok.status).toBe(201);
    });

    it("productos de otro negocio no se ven ni se modifican", async () => {
      const foreign = await ownerDb().product.findFirstOrThrow({ where: { businessId: t.otherBusinessId } });
      expect((await request(app).get(`/v1/products/${foreign.id}`).set(bearer(t.owner))).status).toBe(404);
      expect((await request(app).put(`/v1/products/${foreign.id}`).set(bearer(t.owner)).send(burger())).status).toBe(404);
      expect((await request(app).patch(`/v1/products/${foreign.id}/stock`).set(bearer(t.owner)).send({ stockQuantity: 0 })).status).toBe(404);
      expect((await request(app).delete(`/v1/products/${foreign.id}`).set(bearer(t.owner))).status).toBe(404);
      const list = await request(app).get("/v1/products").set(bearer(t.owner));
      expect(list.body.data.some((p: { id: string }) => p.id === foreign.id)).toBe(false);
    });

    it("borrar un producto", async () => {
      const p = (await request(app).post("/v1/products").set(bearer(t.owner)).send(burger({ name: "Borrable" }))).body;
      await request(app).delete(`/v1/products/${p.id}`).set(bearer(t.owner)).expect(204);
      expect((await request(app).get(`/v1/products/${p.id}`).set(bearer(t.owner))).status).toBe(404);
      expect(await ownerDb().productOption.count({ where: { productId: p.id } })).toBe(0);
    });
  });

  describe("ingredientes", () => {
    it("CRUD, stock bajo y nombre único por negocio", async () => {
      const a = await request(app).post("/v1/ingredients").set(bearer(t.admin)).send({ name: "Pan", quantity: 12.5, unit: "unit", lowStockThreshold: 20 });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ name: "Pan", quantity: 12.5, isLowStock: true, notes: null });
      await request(app).post("/v1/ingredients").set(bearer(t.admin)).send({ name: "Queso", quantity: 5, unit: "kg", lowStockThreshold: 1 }).expect(201);

      expect((await request(app).post("/v1/ingredients").set(bearer(t.admin)).send({ name: "Pan", quantity: 1, unit: "unit", lowStockThreshold: 0 })).status).toBe(409);
      expect((await request(app).post("/v1/ingredients").set(bearer(t.admin)).send({ name: "Sal", quantity: 1, unit: "taza", lowStockThreshold: 0 })).status).toBe(400);

      const low = await request(app).get("/v1/ingredients?lowStock=true").set(bearer(t.staff));
      expect(low.body.data.map((i: { name: string }) => i.name)).toEqual(["Pan"]);

      const upd = await request(app).patch(`/v1/ingredients/${a.body.id}`).set(bearer(t.owner)).send({ quantity: 40 });
      expect(upd.body).toMatchObject({ quantity: 40, isLowStock: false });

      expect((await request(app).post("/v1/ingredients").set(bearer(t.staff)).send({ name: "X", quantity: 1, unit: "kg", lowStockThreshold: 0 })).status).toBe(403);
      await request(app).delete(`/v1/ingredients/${a.body.id}`).set(bearer(t.owner)).expect(204);
      expect((await request(app).delete(`/v1/ingredients/${a.body.id}`).set(bearer(t.owner))).status).toBe(404);
    });
  });
});
