// Agente v3, fase V3b: lo que el panel ve de lo que hace el agente.
// Pedidos modificados, cancelación desde el panel, casos, reembolsos y
// métricas de operación. Plan: toki-agents/docs/12-plan-agente-v3.md §4.4–4.5.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { bearer, createBusiness, createUser, DB_AVAILABLE, ownerDb, seedShop, TEST_AGENT_KEY } from "./helpers.js";

const app = buildApp();
const key = { "x-api-key": TEST_AGENT_KEY };

describe.runIf(DB_AVAILABLE)("panel v3b", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;
  let conversationId: string;

  beforeEach(async () => {
    s = await seedShop("panel-v3b");
    conversationId = (
      await ownerDb().whatsappConversation.create({
        data: { businessId: s.businessId, contactId: "wa-panel", phone: "3815552222" }
      })
    ).id;
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const db = () => ownerDb();
  const ids = () => ({ businessId: s.businessId, conversationId });

  /** Pedido por WhatsApp: 2 gaseosas ($ 5.000), retiro. */
  async function pedido(paymentMethod: "cash" | "transfer" = "cash") {
    await request(app).post("/v1/agent/draft/items").set(key).send({ ...ids(), items: [{ productId: s.sodaId, quantity: 2 }] }).expect(200);
    await request(app)
      .patch("/v1/agent/draft")
      .set(key)
      .send({ ...ids(), customerName: "Ana", orderType: "takeaway", paymentMethod })
      .expect(200);
    const res = await request(app).post("/v1/agent/draft/confirm").set(key).send(ids()).expect(201);
    return res.body as { id: string; orderCode: string };
  }

  const markPaid = async (orderId: string) => {
    await db().order.update({ where: { id: orderId }, data: { paymentStatus: "paid" } });
    await db().payment.updateMany({ where: { orderId }, data: { status: "paid" } });
  };

  /** Otro negocio con su owner, sin vaciar la base. */
  async function otroNegocio() {
    const owner = await createUser("owner@otro-v3b.test");
    const businessId = await createBusiness(owner, "otro-v3b");
    return { owner, businessId };
  }

  describe("pedidos modificados", () => {
    it("el tablero marca el pedido hasta que el local abre el detalle", async () => {
      const order = await pedido();
      let list = await request(app).get("/v1/orders").set(bearer(s.staff)).expect(200);
      expect(list.body.data[0].modification).toMatchObject({ count: 0, seen: true });

      await request(app)
        .post("/v1/agent/orders/modify")
        .set(key)
        .send({ ...ids(), add: [{ productId: s.sodaId, quantity: 1 }] })
        .expect(200);

      list = await request(app).get("/v1/orders").set(bearer(s.staff)).expect(200);
      expect(list.body.data[0].modification).toMatchObject({ count: 1, seen: false, lastDuring: "pending" });

      const detail = await request(app).get(`/v1/orders/${order.id}`).set(bearer(s.staff)).expect(200);
      expect(detail.body.modifications).toHaveLength(1);
      expect(detail.body.modifications[0]).toMatchObject({ source: "whatsapp", totalBefore: 5000, totalAfter: 7500 });
      expect(detail.body.modifications[0].changes.added[0]).toMatchObject({ producto: "Gaseosa", cantidad: 1 });

      const seen = await request(app).post(`/v1/orders/${order.id}/modification-seen`).set(bearer(s.staff)).expect(200);
      expect(seen.body.modification.seen).toBe(true);

      // Un cambio nuevo vuelve a destacarlo.
      await request(app)
        .post("/v1/agent/orders/modify")
        .set(key)
        .send({ ...ids(), orderType: "delivery", deliveryAddress: "Laprida 450" })
        .expect(200);
      list = await request(app).get("/v1/orders").set(bearer(s.staff)).expect(200);
      expect(list.body.data[0].modification).toMatchObject({ count: 2, seen: false });
    });

    it("no se puede marcar como visto un pedido de otro negocio", async () => {
      const order = await pedido();
      const otro = await otroNegocio();
      await request(app)
        .post(`/v1/orders/${order.id}/modification-seen`)
        .set({ ...bearer(otro.owner), "x-business-id": otro.businessId })
        .expect(404);
    });
  });

  describe("cancelar desde el panel", () => {
    it("pagado: deja un reembolso pendiente, devuelve el cupón y lo muestra en el pedido", async () => {
      const order = await pedido("transfer");
      await markPaid(order.id);
      const coupon = await db().coupon.create({
        data: { businessId: s.businessId, code: "PANEL", discountType: "fixed", discountValue: 100, usedCount: 3 }
      });
      await db().order.update({ where: { id: order.id }, data: { couponId: coupon.id } });

      const res = await request(app)
        .patch(`/v1/orders/${order.id}/status`)
        .set(bearer(s.staff))
        .send({ status: "cancelled", note: "Nos quedamos sin gas" })
        .expect(200);
      expect(res.body.cancellation).toMatchObject({ by: "business_dashboard", reason: "Nos quedamos sin gas" });
      expect(res.body.refunds).toHaveLength(1);
      expect(res.body.refunds[0]).toMatchObject({ amount: 5000, reason: "cancelacion", status: "pending" });
      expect((await db().coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(2);
    });
  });

  describe("casos en conversaciones", () => {
    async function canceladoPagadoYDerivado() {
      const order = await pedido("transfer");
      await markPaid(order.id);
      await request(app).post("/v1/agent/orders/cancel").set(key).send(ids()).expect(200);
      await request(app).patch("/v1/agent/refunds/current").set(key).send({ ...ids(), alias: "ana.mp", holder: "Ana" }).expect(200);
      const handoff = await request(app)
        .post(`/v1/agent/conversations/${conversationId}/handoff`)
        .set(key)
        .send({ businessId: s.businessId, reason: "reembolso", summary: "Canceló un pedido pagado" })
        .expect(200);
      return { order, caseId: handoff.body.caso_id as string };
    }

    it("la bandeja muestra el caso con el pedido y el reembolso, y filtra por motivo", async () => {
      const { order } = await canceladoPagadoYDerivado();
      const list = await request(app).get("/v1/conversations?reason=reembolso").set(bearer(s.staff)).expect(200);
      expect(list.body.data).toHaveLength(1);
      const current = list.body.data[0].currentCase;
      expect(current).toMatchObject({ reason: "reembolso", status: "open", summary: "Canceló un pedido pagado" });
      expect(current.order).toMatchObject({ orderCode: order.orderCode, status: "cancelled" });
      expect(current.refunds[0]).toMatchObject({ amount: 5000, status: "pending", destination: { alias: "ana.mp", holder: "Ana" } });

      const otros = await request(app).get("/v1/conversations?reason=queja").set(bearer(s.staff)).expect(200);
      expect(otros.body.data).toHaveLength(0);

      const messages = await request(app).get(`/v1/conversations/${conversationId}/messages`).set(bearer(s.staff)).expect(200);
      expect(messages.body.currentCase.reason).toBe("reembolso");
    });

    it("resolver un caso", async () => {
      const { caseId } = await canceladoPagadoYDerivado();
      const res = await request(app).post(`/v1/cases/${caseId}/resolve`).set(bearer(s.staff)).send({ note: "Ya le devolvimos" }).expect(200);
      expect(res.body).toMatchObject({ status: "resolved", resolutionNote: "Ya le devolvimos" });
      const caso = await db().conversationCase.findUniqueOrThrow({ where: { id: caseId } });
      expect(caso.resolvedBy).toBe(s.staff.id);
      await request(app).post(`/v1/cases/${caseId}/resolve`).set(bearer(s.staff)).send({}).expect(409);
    });

    it("devolver la conversación a Sofi cierra el caso abierto", async () => {
      const { caseId } = await canceladoPagadoYDerivado();
      const res = await request(app)
        .patch(`/v1/conversations/${conversationId}/status`)
        .set(bearer(s.staff))
        .send({ status: "open" })
        .expect(200);
      expect(res.body.currentCase).toBeNull();
      expect((await db().conversationCase.findUniqueOrThrow({ where: { id: caseId } })).status).toBe("resolved");
    });

    it("otro negocio no ve ni resuelve el caso", async () => {
      const { caseId } = await canceladoPagadoYDerivado();
      const otro = await otroNegocio();
      const headers = { ...bearer(otro.owner), "x-business-id": otro.businessId };
      await request(app).post(`/v1/cases/${caseId}/resolve`).set(headers).send({}).expect(404);
      const list = await request(app).get("/v1/conversations").set(headers).expect(200);
      expect(list.body.data).toHaveLength(0);
    });
  });

  describe("reembolsos", () => {
    async function reembolsoPendiente() {
      const order = await pedido("transfer");
      await markPaid(order.id);
      const res = await request(app).post("/v1/agent/orders/cancel").set(key).send(ids()).expect(200);
      expect(res.body.reembolso).toBe(true);
      const refund = await db().orderRefund.findFirstOrThrow({ where: { orderId: order.id } });
      return { order, refundId: refund.id };
    }

    it("el equipo los ve; devolver es de owner o admin", async () => {
      const { refundId } = await reembolsoPendiente();
      const list = await request(app).get("/v1/refunds?status=pending").set(bearer(s.staff)).expect(200);
      expect(list.body.data[0]).toMatchObject({ id: refundId, amount: 5000, status: "pending", reason: "cancelacion" });
      expect(list.body.data[0].order.customerName).toBe("Ana");
      await request(app).post(`/v1/refunds/${refundId}/complete`).set(bearer(s.staff)).send({}).expect(403);
    });

    it("con comprobante: queda devuelto y el pedido reembolsado", async () => {
      const { order, refundId } = await reembolsoPendiente();
      const upload = await request(app)
        .post(`/v1/refunds/${refundId}/proof-upload`)
        .set(bearer(s.owner))
        .send({ contentType: "application/pdf" })
        .expect(200);
      expect(upload.body.key).toMatch(new RegExp(`^${s.businessId}/refund-proofs/${refundId}/.+\\.pdf$`));

      await request(app)
        .post(`/v1/refunds/${refundId}/complete`)
        .set(bearer(s.owner))
        .send({ proofKey: `${s.businessId}/refund-proofs/otro/x.pdf` })
        .expect(400);

      const done = await request(app)
        .post(`/v1/refunds/${refundId}/complete`)
        .set(bearer(s.owner))
        .send({ proofKey: upload.body.key, notes: "Transferido" })
        .expect(200);
      expect(done.body).toMatchObject({ status: "completed", notes: "Transferido" });
      expect(done.body.proofUrl).toContain("refund-proofs");

      const updated = await db().order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
      expect(updated.paymentStatus).toBe("refunded");
      expect(updated.payments.every((p) => p.status === "refunded")).toBe(true);

      await request(app).post(`/v1/refunds/${refundId}/complete`).set(bearer(s.owner)).send({}).expect(409);
    });

    it("rechazar pide un motivo", async () => {
      const { refundId } = await reembolsoPendiente();
      await request(app).post(`/v1/refunds/${refundId}/reject`).set(bearer(s.owner)).send({}).expect(400);
      const res = await request(app)
        .post(`/v1/refunds/${refundId}/reject`)
        .set(bearer(s.owner))
        .send({ notes: "Pagó en efectivo al retirar" })
        .expect(200);
      expect(res.body.status).toBe("rejected");
    });

    it("otro negocio no los ve ni los toca", async () => {
      const { refundId } = await reembolsoPendiente();
      const otro = await otroNegocio();
      const headers = { ...bearer(otro.owner), "x-business-id": otro.businessId };
      const list = await request(app).get("/v1/refunds").set(headers).expect(200);
      expect(list.body.data).toHaveLength(0);
      await request(app).post(`/v1/refunds/${refundId}/complete`).set(headers).send({}).expect(404);
    });
  });

  describe("métricas de operación", () => {
    it("cuenta cancelaciones, reembolsos, casos y modificaciones", async () => {
      // 1: modificado en preparación.
      const a = await pedido();
      await db().order.update({ where: { id: a.id }, data: { status: "preparing" } });
      await request(app).post("/v1/agent/orders/modify").set(key).send({ ...ids(), add: [{ productId: s.sodaId, quantity: 1 }] }).expect(200);
      await db().order.update({ where: { id: a.id }, data: { status: "delivered" } });

      // 2: pagado y cancelado por el cliente, con caso de reembolso.
      const b = await pedido("transfer");
      await markPaid(b.id);
      await request(app).post("/v1/agent/orders/cancel").set(key).send(ids()).expect(200);
      await request(app)
        .post(`/v1/agent/conversations/${conversationId}/handoff`)
        .set(key)
        .send({ businessId: s.businessId, reason: "reembolso" })
        .expect(200);

      // 3: cancelado por el local.
      const c = await pedido();
      await request(app).patch(`/v1/orders/${c.id}/status`).set(bearer(s.owner)).send({ status: "cancelled" }).expect(200);

      const res = await request(app).get("/v1/dashboard/operations?days=7").set(bearer(s.owner)).expect(200);
      expect(res.body.orders).toMatchObject({
        total: 3,
        cancelled: 2,
        cancelRate: 66.7,
        cancelledAmount: 10000,
        cancelledBy: { customerWhatsapp: 1, businessDashboard: 1 }
      });
      expect(res.body.orders.cancelledFromStatus).toEqual([{ status: "pending", count: 2 }]);
      expect(res.body.modifications).toEqual({ orders: 1, rate: 33.3, duringPreparation: 1, total: 1 });
      expect(res.body.refunds.pending).toEqual({ count: 1, amount: 5000 });
      expect(res.body.cases).toEqual([{ reason: "reembolso", open: 1, resolved: 0, avgResolutionMinutes: null }]);
    });
  });
});
