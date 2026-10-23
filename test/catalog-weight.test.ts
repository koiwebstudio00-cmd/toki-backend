import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { seedShop, ownerDb, bearer, DB_AVAILABLE, createUser, createBusiness } from "./helpers.js";
const app = buildApp();
describe.runIf(DB_AVAILABLE)("catálogo por peso", () => {
  let shop: Awaited<ReturnType<typeof seedShop>>;
  let productId: string;
  beforeEach(async () => {
    shop = await seedShop("peso-test");
    const created = await request(app).post("/v1/products").set(bearer(shop.owner)).send({ name: "Tomate por kg", saleUnit: "kg", price: 201.72, trackStock: true, stockQuantity: 5.5, lowStockThreshold: 0.25, options: [] }).expect(201);
    productId = created.body.id;
  });
  afterAll(async () => { await disconnectDb(); });
  const sale = (items: unknown[], extra = {}) => request(app).post("/v1/orders/manual").set(bearer(shop.owner)).send({ paymentMethod: "cash", items, ...extra });
  it("calcula por peso, ajusta hacia arriba y conserva el stock real y el ticket", async () => {
    const res = await sale([{ productId, quantity: 0.5, finalAmount: 101 }]).expect(201);
    expect(res.body.total).toBe(101);
    expect(res.body.items[0]).toMatchObject({ quantity: 0.5, saleUnit: "kg", unitPrice: 201.72, calculatedTotal: 100.86, manualAdjustment: 0.14, totalPrice: 101 });
    expect(Number((await ownerDb().product.findUniqueOrThrow({ where: { id: productId } })).stockQuantity)).toBe(5);
  });
  it("redondea hacia abajo, permite pago al retirar y devuelve peso al cancelar", async () => {
    const res = await sale([{ productId, quantity: 0.5, finalAmount: 100 }], { fulfillment: "kitchen", paymentTiming: "pickup" }).expect(201);
    expect(res.body.items[0].manualAdjustment).toBe(-0.86);
    expect(res.body.paymentStatus).toBe("pending");
    await request(app).patch(`/v1/orders/${res.body.id}/status`).set(bearer(shop.owner)).send({ status: "cancelled" }).expect(200);
    expect(Number((await ownerDb().product.findUniqueOrThrow({ where: { id: productId } })).stockQuantity)).toBe(5.5);
  });
  it("sin ajuste conserva cálculo y rechaza fracciones en productos unitarios", async () => {
    const res = await sale([{ productId, quantity: 0.5 }]).expect(201);
    expect(res.body.total).toBe(100.86);
    await sale([{ productId: shop.sodaId, quantity: 0.5 }]).expect(400);
    await sale([{ productId: shop.sodaId, quantity: 1, finalAmount: 100 }]).expect(400);
    await sale([{ productId, quantity: 0.0001 }]).expect(400);
    await sale([{ productId, quantity: 1, finalAmount: -1 }]).expect(400);
  });
  it("revierte toda la venta si varias líneas exceden el stock", async () => {
    await sale([{ productId, quantity: 3 }, { productId, quantity: 3 }]).expect(400);
    expect(Number((await ownerDb().product.findUniqueOrThrow({ where: { id: productId } })).stockQuantity)).toBe(5.5);
    expect(await ownerDb().order.count()).toBe(0);
  });
  it("conserva precio base más extras y valida el grupo obligatorio", async () => {
    await sale([{ productId: shop.burgerId, quantity: 1 }]).expect(400);
    const options = await ownerDb().productOption.findMany({ where: { productId: shop.burgerId }, include: { values: true } });
    const selected = options.map(o => ({ optionId: o.id, valueIds: [o.values[0]!.id] }));
    const res = await sale([{ productId: shop.burgerId, quantity: 1, options: selected }]).expect(201);
    expect(res.body.total).toBe(11500);
  });
  it("bloquea peso online y productos de otro negocio", async () => {
    await request(app).post(`/v1/public/businesses/${shop.slug}/orders`).send({ customer: { name: "Prueba", phone: "3815559999" }, orderType: "takeaway", paymentMethod: "cash", items: [{ productId, quantity: 1 }] }).expect(400);
    const other = await createUser("other@weight.test");
    const otherBusinessId = await createBusiness(other, "peso-other");
    const foreign = await ownerDb().product.create({ data: { businessId: otherBusinessId, name: "Ajeno", price: 100, saleUnit: "kg" } });
    await sale([{ productId: foreign.id, quantity: 0.5 }]).expect(400);
  });
});
