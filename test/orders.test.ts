// Tablero de pedidos, estados, cobro, venta presencial, comprobantes y el
// ticket del stream. docs/api.md §9.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { emitForTests, stopListening, subscribe, subscriberCount } from "../src/lib/realtime.js";
import { clearTickets, consumeTicket, issueTicket } from "../src/lib/tickets.js";
import { bearer, DB_AVAILABLE, ownerDb, seedShop } from "./helpers.js";

const app = buildApp();

const checkoutBody = (s: Awaited<ReturnType<typeof seedShop>>, overrides: Record<string, unknown> = {}) => ({
  customer: { name: "Ana", phone: "3815550001" },
  orderType: "takeaway",
  paymentMethod: "cash",
  items: [{ productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId] }],
  ...overrides
});

describe.runIf(DB_AVAILABLE)("pedidos", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;
  let orderId: string;

  beforeEach(async () => {
    s = await seedShop("pedidos-test");
    const created = await request(app)
      .post(`/v1/public/businesses/${s.slug}/orders`)
      .send(checkoutBody(s))
      .expect(201);
    orderId = created.body.id;
  });

  afterAll(async () => {
    await stopListening();
    await disconnectDb();
  });

  describe("listado", () => {
    it("trae el pedido con items, opciones, historial y pagos", async () => {
      const res = await request(app).get("/v1/orders").set(bearer(s.owner)).expect(200);
      expect(res.body.meta.total).toBe(1);
      const order = res.body.data[0];
      expect(order.items[0].options[0].valueName).toBe("A punto");
      expect(order.statusHistory).toHaveLength(1);
      expect(order.payments).toHaveLength(1);
      expect(typeof order.total).toBe("number");
    });

    it("filtra por estado, origen y texto", async () => {
      await request(app).get("/v1/orders?status=pending").set(bearer(s.owner)).expect(200);
      const porOrigen = await request(app).get("/v1/orders?source=whatsapp").set(bearer(s.owner)).expect(200);
      expect(porOrigen.body.data).toHaveLength(0);

      const porTexto = await request(app).get("/v1/orders?search=Ana").set(bearer(s.owner)).expect(200);
      expect(porTexto.body.data).toHaveLength(1);

      const sinResultado = await request(app).get("/v1/orders?search=Pedro").set(bearer(s.owner)).expect(200);
      expect(sinResultado.body.data).toHaveLength(0);
    });

    it("pagina", async () => {
      const res = await request(app).get("/v1/orders?page=2&limit=1").set(bearer(s.owner)).expect(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta).toMatchObject({ page: 2, limit: 1, total: 1 });
    });

    it("el staff también ve el tablero", async () => {
      const res = await request(app).get("/v1/orders").set(bearer(s.staff)).expect(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("un negocio no ve los pedidos del otro", async () => {
      const otro = await seedShop("pedidos-otro");
      const res = await request(app).get("/v1/orders").set(bearer(otro.owner)).expect(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe("estados", () => {
    it("cambia el estado y deja historial con la nota", async () => {
      const res = await request(app)
        .patch(`/v1/orders/${orderId}/status`)
        .set(bearer(s.owner))
        .send({ status: "preparing", note: "Arranca la cocina" })
        .expect(200);
      expect(res.body.status).toBe("preparing");
      expect(res.body.statusHistory).toHaveLength(2);
      const ultimo = res.body.statusHistory.at(-1);
      expect(ultimo).toMatchObject({ fromStatus: "pending", toStatus: "preparing", note: "Arranca la cocina" });
    });

    it("rechaza un estado que no existe", async () => {
      await request(app)
        .patch(`/v1/orders/${orderId}/status`)
        .set(bearer(s.owner))
        .send({ status: "volando" })
        .expect(400);
    });

    it("404 si el pedido es de otro negocio", async () => {
      const otro = await seedShop("pedidos-otro-2");
      await request(app)
        .patch(`/v1/orders/${orderId}/status`)
        .set(bearer(otro.owner))
        .send({ status: "preparing" })
        .expect(404);
    });
  });

  describe("cobro", () => {
    it("marca pagado el pedido y su pago", async () => {
      const res = await request(app).post(`/v1/orders/${orderId}/mark-paid`).set(bearer(s.owner)).expect(200);
      expect(res.body.paymentStatus).toBe("paid");
      expect(res.body.payments[0].status).toBe("paid");
    });

    it("404 si el pedido es de otro negocio", async () => {
      const otro = await seedShop("pedidos-otro-3");
      await request(app).post(`/v1/orders/${orderId}/mark-paid`).set(bearer(otro.owner)).expect(404);
    });
  });

  describe("venta presencial", () => {
    it("crea la venta cobrada y entregada, con los precios de la base", async () => {
      const res = await request(app)
        .post("/v1/orders/manual")
        .set(bearer(s.owner))
        .send({
          paymentMethod: "cash",
          items: [
            { productId: s.burgerId, quantity: 1, options: [{ optionId: s.extrasId, valueIds: [s.pancetaId] }] },
            { productId: s.sodaId, quantity: 2, options: [] }
          ]
        })
        .expect(201);

      // (10000 + 1500) + 2500*2 = 16500
      expect(res.body.total).toBe(16500);
      expect(res.body.source).toBe("manual");
      expect(res.body.status).toBe("delivered");
      expect(res.body.paymentStatus).toBe("paid");
      expect(res.body.customerName).toBe("Venta mostrador");
      const item = res.body.items.find((i: { productName: string }) => i.productName === "Doble cheddar");
      expect(item.unitPrice).toBe(11500);
    });

    it("descuenta el descuento y nunca cobra de menos que cero", async () => {
      const res = await request(app)
        .post("/v1/orders/manual")
        .set(bearer(s.owner))
        .send({
          paymentMethod: "cash",
          discountTotal: 500,
          items: [{ productId: s.sodaId, quantity: 1, options: [] }]
        })
        .expect(201);
      expect(res.body.total).toBe(2000);
    });

    it("rechaza un descuento mayor al subtotal", async () => {
      const res = await request(app)
        .post("/v1/orders/manual")
        .set(bearer(s.owner))
        .send({ paymentMethod: "cash", discountTotal: 99999, items: [{ productId: s.sodaId, quantity: 1 }] })
        .expect(400);
      expect(res.body.error.message).toMatch(/descuento/i);
    });

    it("rechaza una opción que no es del producto", async () => {
      await request(app)
        .post("/v1/orders/manual")
        .set(bearer(s.owner))
        .send({
          paymentMethod: "cash",
          items: [{ productId: s.sodaId, quantity: 1, options: [{ optionId: s.extrasId, valueIds: [s.pancetaId] }] }]
        })
        .expect(400);
    });

    it("no vende un producto de otro negocio", async () => {
      const otro = await seedShop("pedidos-otro-4");
      await request(app)
        .post("/v1/orders/manual")
        .set(bearer(otro.owner))
        .send({ paymentMethod: "cash", items: [{ productId: s.sodaId, quantity: 1 }] })
        .expect(400);
    });

    it("guarda el cliente cuando se carga el teléfono", async () => {
      await request(app)
        .post("/v1/orders/manual")
        .set(bearer(s.owner))
        .send({
          customerName: "Julia",
          customerPhone: "3815559999",
          paymentMethod: "transfer",
          items: [{ productId: s.sodaId, quantity: 1 }]
        })
        .expect(201);
      const cliente = await ownerDb().customer.findFirst({ where: { businessId: s.businessId, phone: "3815559999" } });
      expect(cliente?.name).toBe("Julia");
    });
  });

  describe("comprobantes de pago", () => {
    it("lista con URL firmada y permite aprobar sin marcar el pedido pagado", async () => {
      const proof = await ownerDb().orderPaymentProof.create({
        data: { businessId: s.businessId, orderId, storagePath: `${s.businessId}/payment-proofs/x.jpg` }
      });

      const lista = await request(app).get(`/v1/orders/${orderId}/payment-proofs`).set(bearer(s.owner)).expect(200);
      expect(lista.body.data).toHaveLength(1);
      expect(lista.body.data[0].url).toContain(proof.storagePath);

      const revisado = await request(app)
        .patch(`/v1/payment-proofs/${proof.id}`)
        .set(bearer(s.owner))
        .send({ status: "approved" })
        .expect(200);
      expect(revisado.body.status).toBe("approved");
      expect(revisado.body.reviewedAt).toBeTruthy();

      const order = await ownerDb().order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.paymentStatus).toBe("pending");
    });

    it("404 si el comprobante es de otro negocio", async () => {
      const proof = await ownerDb().orderPaymentProof.create({
        data: { businessId: s.businessId, orderId, storagePath: "x/y.jpg" }
      });
      const otro = await seedShop("pedidos-otro-5");
      await request(app)
        .patch(`/v1/payment-proofs/${proof.id}`)
        .set(bearer(otro.owner))
        .send({ status: "rejected" })
        .expect(404);
    });
  });

  describe("tiempo real", () => {
    it("el ticket sirve una sola vez y vence", () => {
      clearTickets();
      const { ticket, expiresIn } = issueTicket("negocio-1", "user-1");
      expect(expiresIn).toBe(60);
      expect(consumeTicket(ticket)?.businessId).toBe("negocio-1");
      expect(consumeTicket(ticket)).toBeNull();
      expect(consumeTicket("inventado")).toBeNull();
    });

    it("emite el ticket al dueño autenticado", async () => {
      const res = await request(app).post("/v1/orders/events/ticket").set(bearer(s.owner)).expect(200);
      expect(res.body.ticket).toMatch(/^[a-f0-9]{64}$/);
      expect(consumeTicket(res.body.ticket)?.businessId).toBe(s.businessId);
    });

    it("el stream rechaza un ticket inválido", async () => {
      const res = await request(app).get("/v1/orders/events?ticket=nope").expect(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("el evento llega solo al negocio del pedido", () => {
      const recibidosA: string[] = [];
      const recibidosB: string[] = [];
      const offA = subscribe("negocio-a", (e) => recibidosA.push(e.orderId), () => {});
      const offB = subscribe("negocio-b", (e) => recibidosB.push(e.orderId), () => {});

      emitForTests("negocio-a", { orderId: "pedido-1", op: "INSERT" });

      expect(recibidosA).toEqual(["pedido-1"]);
      expect(recibidosB).toEqual([]);
      offA();
      offB();
      expect(subscriberCount()).toBe(0);
    });
  });
});
