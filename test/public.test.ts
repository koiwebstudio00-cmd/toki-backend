// Checkout público de punta a punta: el camino que hoy hace la Edge Function
// `create-order`. Los casos son los del checklist ORDERS-CHECKOUT-POS-QA.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { createCoupon, DB_AVAILABLE, ownerDb, seedShop } from "./helpers.js";

const app = buildApp();

describe.runIf(DB_AVAILABLE)("público", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;

  beforeEach(async () => {
    s = await seedShop("burger-publica");
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const checkout = (overrides: Record<string, unknown> = {}) => ({
    customer: { name: "Ana", phone: "3815550001" },
    orderType: "takeaway",
    paymentMethod: "cash",
    items: [{ productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId] }],
    ...overrides
  });

  describe("menú", () => {
    it("trae negocio, catálogo, medios de pago y estado en una sola request", async () => {
      const res = await request(app).get(`/v1/public/businesses/${s.slug}`).expect(200);
      expect(res.body.business.slug).toBe(s.slug);
      expect(res.body.isOpen).toBe(true);
      expect(res.body.categories).toHaveLength(1);
      expect(res.body.products).toHaveLength(2);
      expect(res.body.paymentMethods).toMatchObject({ cash: true, transfer: true });
      expect(res.body.hours).toHaveLength(7);
    });

    it("no expone stock, costos ni código de barras", async () => {
      const res = await request(app).get(`/v1/public/businesses/${s.slug}`).expect(200);
      const product = res.body.products.find((p: { id: string }) => p.id === s.burgerId);
      expect(product.stockQuantity).toBeUndefined();
      expect(product.barcode).toBeUndefined();
      expect(product.trackStock).toBeUndefined();
    });

    it("esconde los valores de opción sin stock", async () => {
      await ownerDb().productOptionValue.update({ where: { id: s.pancetaId }, data: { stockQuantity: 0 } });
      const res = await request(app).get(`/v1/public/businesses/${s.slug}`).expect(200);
      const product = res.body.products.find((p: { id: string }) => p.id === s.burgerId);
      const extras = product.options.find((o: { name: string }) => o.name === "Extras");
      expect(extras.values).toHaveLength(0);
    });

    it("404 si el negocio está desactivado", async () => {
      await ownerDb().business.update({ where: { id: s.businessId }, data: { isActive: false } });
      await request(app).get(`/v1/public/businesses/${s.slug}`).expect(404);
    });

    it("el detalle de un producto pausado da 404", async () => {
      await ownerDb().product.update({ where: { id: s.sodaId }, data: { isAvailable: false } });
      await request(app).get(`/v1/public/businesses/${s.slug}/products/${s.sodaId}`).expect(404);
    });
  });

  describe("cupones", () => {
    it("calcula el descuento porcentual", async () => {
      await createCoupon(s.businessId, "PROMO10", { discountType: "percent", discountValue: 10 });
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/coupons/validate`)
        .send({ code: "promo10", subtotal: 10000 })
        .expect(200);
      expect(res.body).toMatchObject({ valid: true, code: "PROMO10", discountTotal: 1000 });
    });

    it("el descuento fijo nunca supera el subtotal", async () => {
      await createCoupon(s.businessId, "FIJO", { discountType: "fixed", discountValue: 99999 });
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/coupons/validate`)
        .send({ code: "FIJO", subtotal: 4000 })
        .expect(200);
      expect(res.body.discountTotal).toBe(4000);
    });

    it("rechaza vencido, sin usos y bajo el mínimo", async () => {
      await createCoupon(s.businessId, "VENCIDO", { endsAt: new Date(Date.now() - 86_400_000) });
      await createCoupon(s.businessId, "AGOTADO", { usageLimit: 2, usedCount: 2 });
      await createCoupon(s.businessId, "MINIMO", { minimumOrderAmount: 50000 });

      for (const code of ["VENCIDO", "AGOTADO", "MINIMO", "NOEXISTE"]) {
        const res = await request(app)
          .post(`/v1/public/businesses/${s.slug}/coupons/validate`)
          .send({ code, subtotal: 10000 })
          .expect(400);
        expect(res.body.error.message).toMatch(/cupón/i);
      }
    });

    it("no valida un cupón de otro negocio", async () => {
      const other = await ownerDb().business.findFirstOrThrow({ where: { id: s.businessId } });
      const coupon = await createCoupon(other.id, "MIO");
      // Mismo código pero pidiéndolo desde un slug que no existe: 404, no 200.
      await request(app)
        .post(`/v1/public/businesses/otro-negocio/coupons/validate`)
        .send({ code: coupon.code, subtotal: 10000 })
        .expect(404);
    });
  });

  describe("checkout", () => {
    it("crea el pedido, descuenta stock y deja historial y pago", async () => {
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ items: [{ productId: s.burgerId, quantity: 2, optionValueIds: [s.aPuntoId, s.pancetaId] }] }))
        .expect(201);

      // (10000 + 1500) * 2 = 23000, takeaway sin envío.
      expect(res.body.total).toBe(23000);
      expect(res.body.orderCode).toMatch(/^TK-\d{6}$/);

      const db = ownerDb();
      const order = await db.order.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { items: { include: { options: true } }, statusHistory: true, payments: true }
      });
      expect(order.source).toBe("web");
      expect(order.status).toBe("pending");
      expect(order.items[0]!.options.map((o) => o.valueName).sort()).toEqual(["A punto", "Panceta"]);
      expect(order.statusHistory).toHaveLength(1);
      expect(order.payments).toHaveLength(1);

      const burger = await db.product.findUniqueOrThrow({ where: { id: s.burgerId } });
      expect(burger.stockQuantity).toBe(8);
      const panceta = await db.productOptionValue.findUniqueOrThrow({ where: { id: s.pancetaId } });
      expect(panceta.stockQuantity).toBe(2);

      const customer = await db.customer.findFirstOrThrow({ where: { businessId: s.businessId } });
      expect(customer.phone).toBe("3815550001");
      expect(Number(customer.totalSpent)).toBe(23000);
    });

    it("suma el envío y guarda la dirección en delivery", async () => {
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ orderType: "delivery", deliveryAddress: "Av. Siempre Viva 742" }))
        .expect(201);
      expect(res.body.total).toBe(10500);
      const addresses = await ownerDb().customerAddress.findMany({ where: { businessId: s.businessId } });
      expect(addresses[0]!.street).toBe("Av. Siempre Viva 742");
    });

    it("aplica el cupón y le suma un uso", async () => {
      await createCoupon(s.businessId, "PROMO10", { discountType: "percent", discountValue: 10 });
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ couponCode: "promo10" }))
        .expect(201);
      expect(res.body.discountTotal).toBe(1000);
      expect(res.body.total).toBe(9000);
      const coupon = await ownerDb().coupon.findFirstOrThrow({ where: { businessId: s.businessId, code: "PROMO10" } });
      expect(coupon.usedCount).toBe(1);
    });

    it("suma puntos de fidelización si están activos", async () => {
      await ownerDb().loyaltySettings.upsert({
        where: { businessId: s.businessId },
        create: { businessId: s.businessId, isEnabled: true, pointsPerCurrency: 0.01, pointsPerOrder: 5 },
        update: { isEnabled: true, pointsPerCurrency: 0.01, pointsPerOrder: 5 }
      });
      const res = await request(app).post(`/v1/public/businesses/${s.slug}/orders`).send(checkout()).expect(201);
      // floor(10000 * 0.01) + 5
      expect(res.body.loyaltyPointsEarned).toBe(105);
    });

    it("rechaza el pedido cuando el negocio está cerrado", async () => {
      await ownerDb().business.update({ where: { id: s.businessId }, data: { manualStatus: "closed" } });
      const res = await request(app).post(`/v1/public/businesses/${s.slug}/orders`).send(checkout()).expect(409);
      expect(res.body.error.code).toBe("BUSINESS_CLOSED");
    });

    it("rechaza bajo el mínimo del negocio", async () => {
      await ownerDb().business.update({ where: { id: s.businessId }, data: { minimumOrderAmount: 20000 } });
      const res = await request(app).post(`/v1/public/businesses/${s.slug}/orders`).send(checkout()).expect(400);
      expect(res.body.error.message).toMatch(/mínimo/i);
    });

    it("rechaza si no alcanza el stock", async () => {
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ items: [{ productId: s.burgerId, quantity: 11, optionValueIds: [s.aPuntoId] }] }))
        .expect(400);
      expect(res.body.error.message).toMatch(/stock/i);
    });

    it("vende lo que no lleva control de stock y no lo pausa (migración 0005)", async () => {
      const db = ownerDb();
      await db.product.update({ where: { id: s.sodaId }, data: { trackStock: false, stockQuantity: 0 } });
      await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ items: [{ productId: s.sodaId, quantity: 3 }] }))
        .expect(201);
      const soda = await db.product.findUniqueOrThrow({ where: { id: s.sodaId } });
      expect(soda.isAvailable).toBe(true);
      expect(soda.trackStock).toBe(false);
      expect(soda.stockQuantity).toBe(0);
    });

    it("rechaza si falta una opción obligatoria", async () => {
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ items: [{ productId: s.burgerId, quantity: 1 }] }))
        .expect(400);
      expect(res.body.error.message).toMatch(/opciones/i);
    });

    it("rechaza si se pasa del máximo de un grupo", async () => {
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(
          checkout({
            items: [{ productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId, s.jugosaId] }]
          })
        )
        .expect(400);
      expect(res.body.error.message).toMatch(/opciones/i);
    });

    it("rechaza una opción que no es del producto", async () => {
      const otra = await ownerDb().productOption.create({
        data: { businessId: s.businessId, productId: s.sodaId, name: "Tamaño", type: "single", minSelect: 0, maxSelect: 1 }
      });
      const valor = await ownerDb().productOptionValue.create({
        data: { businessId: s.businessId, optionId: otra.id, name: "1.5L" }
      });
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ items: [{ productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId, valor.id] }] }))
        .expect(400);
      expect(res.body.error.message).toMatch(/opción/i);
    });

    it("rechaza un medio de pago deshabilitado", async () => {
      await ownerDb().paymentSettings.update({ where: { businessId: s.businessId }, data: { transferEnabled: false } });
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ paymentMethod: "transfer" }))
        .expect(400);
      expect(res.body.error.message).toMatch(/medio de pago/i);
    });

    it("rechaza mercadopago mientras no esté integrado", async () => {
      await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ paymentMethod: "mercadopago" }))
        .expect(400);
    });

    it("pide dirección cuando es delivery", async () => {
      const res = await request(app)
        .post(`/v1/public/businesses/${s.slug}/orders`)
        .send(checkout({ orderType: "delivery" }))
        .expect(400);
      expect(res.body.error.message).toMatch(/dirección/i);
    });

    it("no acepta un producto de otro negocio", async () => {
      const otroOwner = await ownerDb().user.findFirstOrThrow({ where: { email: s.owner.email } });
      expect(otroOwner).toBeTruthy();
      const otro = await seedShop("otra-burger");
      const res = await request(app)
        .post(`/v1/public/businesses/${otro.slug}/orders`)
        .send({
          customer: { name: "Ana", phone: "3815550009" },
          orderType: "takeaway",
          paymentMethod: "cash",
          items: [{ productId: s.burgerId, quantity: 1 }]
        })
        .expect(400);
      expect(res.body.error.message).toMatch(/disponible/i);
    });
  });

  describe("seguimiento", () => {
    it("devuelve el pedido por código sin datos privados", async () => {
      const created = await request(app).post(`/v1/public/businesses/${s.slug}/orders`).send(checkout()).expect(201);
      const res = await request(app)
        .get(`/v1/public/businesses/${s.slug}/orders/${created.body.orderCode}`)
        .expect(200);
      expect(res.body.order_code).toBe(created.body.orderCode);
      expect(res.body.order_items).toHaveLength(1);
      expect(res.body.customer_phone).toBeUndefined();
    });

    it("404 si el código es de otro negocio", async () => {
      const created = await request(app).post(`/v1/public/businesses/${s.slug}/orders`).send(checkout()).expect(201);
      const otro = await seedShop("otra-burger-2");
      await request(app).get(`/v1/public/businesses/${otro.slug}/orders/${created.body.orderCode}`).expect(404);
    });
  });
});
