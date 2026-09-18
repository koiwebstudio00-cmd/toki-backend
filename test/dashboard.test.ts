// Resumen y buscador del panel — docs/api.md §11.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { bearer, DB_AVAILABLE, ownerDb, seedShop } from "./helpers.js";

const app = buildApp();

describe.runIf(DB_AVAILABLE)("dashboard y clientes", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;

  beforeEach(async () => {
    s = await seedShop("panel-test");
    // Dos pedidos web (uno cancelado después) y una venta de mostrador.
    for (const phone of ["3815550001", "3815550002"]) {
      await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send({
          customer: { name: `Cliente ${phone.slice(-1)}`, phone },
          orderType: "takeaway",
          paymentMethod: "cash",
          items: [{ productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId] }]
        })
        .expect(201);
    }
  });

  afterAll(async () => {
    await disconnectDb();
  });

  describe("resumen", () => {
    it("suma ventas del día, pedidos pendientes y ticket promedio", async () => {
      const res = await request(app).get("/v1/dashboard/summary").set(bearer(s.owner)).expect(200);
      expect(res.body.sales.today).toBe(20000);
      expect(res.body.sales.month).toBe(20000);
      expect(res.body.orders.today).toBe(2);
      expect(res.body.orders.pending).toBe(2);
      expect(res.body.orders.byStatus.pending).toBe(2);
      expect(res.body.averageTicket).toBe(10000);
      expect(res.body.timezone).toBe("America/Argentina/Buenos_Aires");
    });

    it("no cuenta como venta un pedido cancelado", async () => {
      const orders = await ownerDb().order.findMany({ where: { businessId: s.businessId }, take: 1 });
      await ownerDb().order.update({ where: { id: orders[0]!.id }, data: { status: "cancelled" } });

      const res = await request(app).get("/v1/dashboard/summary").set(bearer(s.owner)).expect(200);
      expect(res.body.sales.today).toBe(10000);
      expect(res.body.orders.today).toBe(2);
      expect(res.body.orders.byStatus.cancelled).toBe(1);
    });

    it("devuelve la serie de días completa, con ceros incluidos", async () => {
      const res = await request(app).get("/v1/dashboard/summary?days=7").set(bearer(s.owner)).expect(200);
      expect(res.body.salesByDay).toHaveLength(7);
      expect(res.body.salesByDay.at(-1).total).toBe(20000);
      expect(res.body.salesByDay[0].total).toBe(0);
    });

    it("rankea los productos más vendidos", async () => {
      const res = await request(app).get("/v1/dashboard/summary").set(bearer(s.owner)).expect(200);
      expect(res.body.topProducts[0]).toMatchObject({ name: "Doble cheddar", quantity: 2, total: 20000 });
    });

    it("avisa del stock bajo de productos, opciones e insumos", async () => {
      const db = ownerDb();
      await db.product.update({ where: { id: s.burgerId }, data: { stockQuantity: 2, lowStockThreshold: 5 } });
      await db.productOptionValue.update({ where: { id: s.pancetaId }, data: { stockQuantity: 1, lowStockThreshold: 5 } });
      await db.inventoryIngredient.create({
        data: { businessId: s.businessId, name: "Cheddar", quantity: 1, lowStockThreshold: 3, unit: "kg" }
      });

      const res = await request(app).get("/v1/dashboard/summary").set(bearer(s.owner)).expect(200);
      expect(res.body.lowStock.products[0].name).toBe("Doble cheddar");
      expect(res.body.lowStock.optionValues[0].name).toBe("Panceta");
      expect(res.body.lowStock.ingredients[0]).toMatchObject({ name: "Cheddar", quantity: 1, unit: "kg" });
    });

    it("los últimos pedidos vienen con el total como número", async () => {
      const res = await request(app).get("/v1/dashboard/summary").set(bearer(s.owner)).expect(200);
      expect(res.body.recentOrders).toHaveLength(2);
      expect(typeof res.body.recentOrders[0].total).toBe("number");
      expect(res.body.bot).toHaveProperty("enabled");
      expect(res.body.conversationsCount).toBe(0);
    });

    it("cada negocio ve solo lo suyo", async () => {
      const otro = await seedShop("panel-otro");
      const res = await request(app).get("/v1/dashboard/summary").set(bearer(otro.owner)).expect(200);
      expect(res.body.sales.today).toBe(0);
      expect(res.body.recentOrders).toHaveLength(0);
    });

    it("sin sesión, 401", async () => {
      await request(app).get("/v1/dashboard/summary").expect(401);
    });
  });

  describe("buscador", () => {
    it("encuentra productos por nombre", async () => {
      const res = await request(app).get("/v1/dashboard/search?q=cheddar").set(bearer(s.owner)).expect(200);
      const nombres = res.body.data.map((r: { title: string }) => r.title);
      expect(nombres).toContain("Doble cheddar");
    });

    it("encuentra clientes por nombre", async () => {
      const res = await request(app).get("/v1/dashboard/search?q=Cliente").set(bearer(s.owner)).expect(200);
      expect(res.body.data.some((r: { group: string }) => r.group === "Clientes")).toBe(true);
    });

    it("pide al menos 2 letras", async () => {
      await request(app).get("/v1/dashboard/search?q=a").set(bearer(s.owner)).expect(400);
    });

    it("no devuelve datos de otro negocio", async () => {
      const otro = await seedShop("panel-otro-2");
      const res = await request(app).get("/v1/dashboard/search?q=cheddar").set(bearer(otro.owner)).expect(200);
      expect(res.body.data.filter((r: { group: string }) => r.group === "Productos")).toHaveLength(1);
    });
  });

  describe("clientes", () => {
    it("lista con pedidos, gastado y último pedido calculados en SQL", async () => {
      const res = await request(app).get("/v1/customers").set(bearer(s.owner)).expect(200);
      expect(res.body.meta.total).toBe(2);
      const cliente = res.body.data[0];
      expect(cliente.ordersCount).toBe(1);
      expect(cliente.ordersTotal).toBe(10000);
      expect(cliente.totalSpent).toBe(10000);
      expect(cliente.lastOrderAt).toBeTruthy();
    });

    it("busca por nombre o teléfono", async () => {
      const res = await request(app).get("/v1/customers?search=3815550002").set(bearer(s.owner)).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].phone).toBe("3815550002");
    });

    it("el detalle trae direcciones y últimos pedidos", async () => {
      const lista = await request(app).get("/v1/customers").set(bearer(s.owner)).expect(200);
      const id = lista.body.data[0].id;
      const res = await request(app).get(`/v1/customers/${id}`).set(bearer(s.owner)).expect(200);
      expect(res.body.orders).toHaveLength(1);
      expect(res.body).toHaveProperty("addresses");
      expect(typeof res.body.orders[0].total).toBe("number");
    });

    it("404 si el cliente es de otro negocio", async () => {
      const lista = await request(app).get("/v1/customers").set(bearer(s.owner)).expect(200);
      const otro = await seedShop("panel-otro-3");
      await request(app).get(`/v1/customers/${lista.body.data[0].id}`).set(bearer(otro.owner)).expect(404);
    });
  });
});
