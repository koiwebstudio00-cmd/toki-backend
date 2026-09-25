// Agente v3, fase V3: pedidos hechos (modificar, cancelar, estado), stock,
// casos, reembolsos, comprobante en ráfaga y cancelación desde el dashboard.
// Plan: toki-agents/docs/12-plan-agente-v3.md §3.4, §4.4 y §4.5.
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La subida a R2 se reemplaza: acá se prueba de dónde sale el adjunto, no R2.
vi.mock("../src/lib/r2.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/r2.js")>();
  return { ...original, putObject: vi.fn().mockResolvedValue(undefined) };
});

import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { bearer, DB_AVAILABLE, ownerDb, seedShop, TEST_AGENT_KEY } from "./helpers.js";

const app = buildApp();
const key = { "x-api-key": TEST_AGENT_KEY };

describe.runIf(DB_AVAILABLE)("agente v3: pedidos hechos", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;
  let conversationId: string;

  beforeEach(async () => {
    s = await seedShop("agente-v3-pedidos");
    conversationId = (
      await ownerDb().whatsappConversation.create({
        data: { businessId: s.businessId, contactId: "wa-p", phone: "3815551111" }
      })
    ).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const ids = () => ({ businessId: s.businessId, conversationId });
  const db = () => ownerDb();

  /** Pedido confirmado: 1 Doble cheddar (a punto + panceta) y 2 gaseosas. Total $ 16.500. */
  async function pedido(paymentMethod: "cash" | "transfer" = "cash") {
    await request(app)
      .post("/v1/agent/draft/items")
      .set(key)
      .send({
        ...ids(),
        items: [
          { productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId, s.pancetaId] },
          { productId: s.sodaId, quantity: 2 }
        ]
      })
      .expect(200);
    await request(app)
      .patch("/v1/agent/draft")
      .set(key)
      .send({ ...ids(), customerName: "Ana", orderType: "takeaway", paymentMethod })
      .expect(200);
    const res = await request(app).post("/v1/agent/draft/confirm").set(key).send(ids()).expect(201);
    const order = await db().order.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { items: { orderBy: { createdAt: "asc" } } }
    });
    return order;
  }

  const setStatus = (orderId: string, status: "confirmed" | "preparing" | "ready" | "out_for_delivery") =>
    db().order.update({ where: { id: orderId }, data: { status } });

  const markPaid = async (orderId: string) => {
    await db().order.update({ where: { id: orderId }, data: { paymentStatus: "paid" } });
    await db().payment.updateMany({ where: { orderId }, data: { status: "paid" } });
  };

  const stock = async () => ({
    burger: (await db().product.findUniqueOrThrow({ where: { id: s.burgerId } })).stockQuantity,
    panceta: (await db().productOptionValue.findUniqueOrThrow({ where: { id: s.pancetaId } })).stockQuantity
  });

  const modify = (body: object) =>
    request(app).post("/v1/agent/orders/modify").set(key).send({ ...ids(), ...body }).expect(200);
  const cancel = (body: object = {}) =>
    request(app).post("/v1/agent/orders/cancel").set(key).send({ ...ids(), ...body }).expect(200);

  describe("estado", () => {
    it("dice en palabras el estado, si se puede cambiar o cancelar, y pasa el seguimiento", async () => {
      const order = await pedido();
      await setStatus(order.id, "preparing");
      const res = await request(app)
        .get(`/v1/agent/orders/status?businessId=${s.businessId}&conversationId=${conversationId}`)
        .set(key)
        .expect(200);
      expect(res.body.pedido).toMatchObject({
        status_label: "en preparación",
        editable: true,
        cancelable: false
      });
      expect(res.body.pedido.track_url).toContain(`/order/${order.orderCode}`);
      // Con el id del item el agente puede sacarlo o cambiarle la cantidad.
      expect(res.body.pedido.items.map((i: { id: string }) => i.id).sort()).toEqual(order.items.map((i) => i.id).sort());
    });

    it("el contexto usa las mismas reglas", async () => {
      const order = await pedido();
      await setStatus(order.id, "ready");
      const res = await request(app)
        .get(`/v1/agent/conversations/${conversationId}/context?businessId=${s.businessId}`)
        .set(key)
        .expect(200);
      expect(res.body.active_order).toMatchObject({ editable: false, cancelable: false, status_label: "listo para retirar" });
    });
  });

  describe("modificar", () => {
    it("guarda el stock descontado al confirmar", async () => {
      await pedido();
      expect(await stock()).toEqual({ burger: 9, panceta: 3 });
      // Desde 0010 las opciones guardan el id del valor: se pueden devolver.
      const opts = await db().orderItemOption.findMany({ where: { valueName: "Panceta" } });
      expect(opts[0]!.optionValueId).toBe(s.pancetaId);
    });

    it("suma un producto con los ids de la carta y recalcula", async () => {
      const order = await pedido();
      const res = await modify({ add: [{ productId: s.burgerId.slice(0, 6), quantity: 1, optionValueIds: [s.jugosaId] }] });
      expect(res.body.ok).toBe(true);
      expect(res.body.total_anterior).toBe(16500);
      expect(res.body.total_nuevo).toBe(26500);
      expect(res.body.cambios.added[0]).toMatchObject({ producto: "Doble cheddar", cantidad: 1, opciones: ["Jugosa"] });
      expect((await stock()).burger).toBe(8);

      const updated = await db().order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated).toMatchObject({ modificationCount: 1, lastModifiedDuring: "pending" });
      expect(Number(updated.total)).toBe(26500);
      expect(updated.modifiedAt).not.toBeNull();
      const payment = await db().payment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(Number(payment.amount)).toBe(26500);

      const mod = await db().orderModification.findFirstOrThrow({ where: { orderId: order.id } });
      expect(mod).toMatchObject({ source: "whatsapp", statusAtChange: "pending", conversationId });
      expect(Number(mod.totalAfter)).toBe(26500);
    });

    it("bajar una cantidad devuelve el stock del producto y de la opción", async () => {
      const order = await pedido();
      const burgerItem = order.items.find((i) => i.productName === "Doble cheddar")!;
      await modify({ quantities: [{ itemId: burgerItem.id, quantity: 2 }] });
      expect(await stock()).toEqual({ burger: 8, panceta: 2 });
      await modify({ quantities: [{ itemId: burgerItem.id, quantity: 1 }] });
      expect(await stock()).toEqual({ burger: 9, panceta: 3 });
    });

    it("sacar un producto devuelve su stock", async () => {
      const order = await pedido();
      const burgerItem = order.items.find((i) => i.productName === "Doble cheddar")!;
      const res = await modify({ remove: [burgerItem.id] });
      expect(res.body.total_nuevo).toBe(5000);
      expect(await stock()).toEqual({ burger: 10, panceta: 4 });
      expect(await db().orderItem.count({ where: { orderId: order.id } })).toBe(1);
    });

    it("en preparación se puede y queda marcado", async () => {
      const order = await pedido();
      await setStatus(order.id, "preparing");
      const res = await modify({ add: [{ productId: s.sodaId, quantity: 1 }] });
      expect(res.body.ok).toBe(true);
      const updated = await db().order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated.lastModifiedDuring).toBe("preparing");
      const history = await db().orderStatusHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
      expect(history.at(-1)!.note).toMatch(/durante la preparación/);
    });

    it("listo o en camino: deriva y no toca nada", async () => {
      const order = await pedido();
      for (const status of ["ready", "out_for_delivery"] as const) {
        await setStatus(order.id, status);
        const res = await modify({ add: [{ productId: s.sodaId, quantity: 1 }] });
        expect(res.body).toMatchObject({ ok: false, derivar: true });
      }
      expect(await db().orderItem.count({ where: { orderId: order.id } })).toBe(2);
    });

    it("pasa a delivery con dirección y suma el envío", async () => {
      const order = await pedido();
      const res = await modify({ orderType: "delivery", deliveryAddress: "Laprida 450" });
      expect(res.body.total_nuevo).toBe(17000);
      expect(res.body.cambios.fields.map((f: { campo: string }) => f.campo)).toEqual(["entrega", "direccion"]);
      const updated = await db().order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated).toMatchObject({ orderType: "delivery", deliveryAddress: "Laprida 450" });
    });

    it("a delivery sin dirección no se puede", async () => {
      await pedido();
      const res = await modify({ orderType: "delivery" });
      expect(res.body).toMatchObject({ ok: false });
      expect(res.body.error).toMatch(/dirección/);
    });

    it("no deja el pedido vacío y no escribe nada si algo falla", async () => {
      const order = await pedido();
      const res = await modify({ remove: order.items.map((i) => i.id) });
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/vacío/);
      expect(await db().orderItem.count({ where: { orderId: order.id } })).toBe(2);
      expect(await stock()).toEqual({ burger: 9, panceta: 3 });
    });

    it("respeta el pedido mínimo", async () => {
      const order = await pedido();
      await db().business.update({ where: { id: s.businessId }, data: { minimumOrderAmount: 15000 } });
      const burgerItem = order.items.find((i) => i.productName === "Doble cheddar")!;
      const res = await modify({ remove: [burgerItem.id] });
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/mínimo/);
    });

    it("pagado y sube el total: queda saldo a pagar", async () => {
      const order = await pedido("transfer");
      await markPaid(order.id);
      const res = await modify({ add: [{ productId: s.sodaId, quantity: 1 }] });
      expect(res.body).toMatchObject({ ok: true, saldo_pendiente: 2500 });
      const updated = await db().order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated.paymentStatus).toBe("pending");
      const pending = await db().payment.findFirstOrThrow({ where: { orderId: order.id, status: "pending" } });
      expect(Number(pending.amount)).toBe(2500);
    });

    it("pagado y baja el total: queda un reembolso pendiente", async () => {
      const order = await pedido("transfer");
      await markPaid(order.id);
      const sodaItem = order.items.find((i) => i.productName === "Gaseosa")!;
      const res = await modify({ quantities: [{ itemId: sodaItem.id, quantity: 1 }] });
      expect(res.body).toMatchObject({ ok: true, reembolso: true, monto_reembolso: 2500 });
      const refund = await db().orderRefund.findFirstOrThrow({ where: { orderId: order.id } });
      expect(refund).toMatchObject({ reason: "modificacion_baja_total", status: "pending", originalPaymentMethod: "transfer" });
    });

    it("un código de otro negocio no se encuentra", async () => {
      const order = await pedido();
      const otro = await ownerDb().business.create({ data: { name: "Otro", slug: "otro-negocio-v3" } });
      const res = await request(app)
        .post("/v1/agent/orders/modify")
        .set(key)
        .send({
          businessId: otro.id,
          conversationId,
          orderCode: order.orderCode,
          add: [{ productId: s.sodaId, quantity: 1 }]
        })
        .expect(200);
      expect(res.body).toEqual({ ok: false, error: "Conversacion invalida." });
    });
  });

  describe("cancelar", () => {
    it("pendiente: cancela, devuelve stock y lo deja registrado", async () => {
      const order = await pedido();
      const res = await cancel({ reason: "me equivoqué" });
      expect(res.body).toMatchObject({ ok: true, orderCode: order.orderCode, estado: "cancelado" });
      expect(res.body).not.toHaveProperty("reembolso");
      expect(await stock()).toEqual({ burger: 10, panceta: 4 });
      const updated = await db().order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated).toMatchObject({ status: "cancelled", cancelledBy: "customer_whatsapp", cancellationReason: "me equivoqué" });
      const history = await db().orderStatusHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
      expect(history.at(-1)).toMatchObject({ fromStatus: "pending", toStatus: "cancelled" });
    });

    it("un pedido anterior a 0010 (sin id de la opción) devuelve el stock buscando por nombre", async () => {
      const order = await pedido();
      await db().orderItemOption.updateMany({ where: { orderItem: { orderId: order.id } }, data: { optionValueId: null } });
      await cancel();
      expect(await stock()).toEqual({ burger: 10, panceta: 4 });
    });

    it("dos veces no devuelve el stock dos veces", async () => {
      const order = await pedido();
      await cancel();
      const again = await cancel({ orderCode: order.orderCode });
      expect(again.body).toMatchObject({ ok: true, yaEstaba: true });
      expect(await stock()).toEqual({ burger: 10, panceta: 4 });
    });

    it("un producto que se había pausado por quedarse sin stock vuelve a estar disponible", async () => {
      await db().product.update({ where: { id: s.burgerId }, data: { stockQuantity: 1 } });
      await pedido();
      expect((await db().product.findUniqueOrThrow({ where: { id: s.burgerId } })).isAvailable).toBe(false);
      await cancel();
      const burger = await db().product.findUniqueOrThrow({ where: { id: s.burgerId } });
      expect(burger).toMatchObject({ stockQuantity: 1, isAvailable: true });
    });

    it("aceptado por el local: deriva", async () => {
      const order = await pedido();
      await setStatus(order.id, "confirmed");
      const res = await cancel();
      expect(res.body).toMatchObject({ ok: false, derivar: true });
      expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("confirmed");
    });

    it("devuelve el uso del cupón", async () => {
      const order = await pedido();
      const coupon = await db().coupon.create({
        data: { businessId: s.businessId, code: "HOLA", discountType: "fixed", discountValue: 100, usedCount: 1 }
      });
      await db().order.update({ where: { id: order.id }, data: { couponId: coupon.id, couponCode: "HOLA" } });
      await cancel();
      expect((await db().coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
    });

    it("pagado: cancela y deja un reembolso pendiente", async () => {
      const order = await pedido("transfer");
      await markPaid(order.id);
      const res = await cancel();
      expect(res.body).toMatchObject({ ok: true, reembolso: true, monto_reembolso: 16500 });
      const refund = await db().orderRefund.findFirstOrThrow({ where: { orderId: order.id } });
      expect(refund).toMatchObject({ reason: "cancelacion", status: "pending", conversationId });
    });
  });

  describe("reembolso y derivación", () => {
    it("guarda a dónde devolver y el caso queda atado al pedido y al reembolso", async () => {
      const order = await pedido("transfer");
      await markPaid(order.id);
      await cancel();

      const dest = await request(app)
        .patch("/v1/agent/refunds/current")
        .set(key)
        .send({ ...ids(), alias: "ana.mp", holder: "Ana Gómez" })
        .expect(200);
      expect(dest.body).toMatchObject({ ok: true, monto: 16500, destino: { alias: "ana.mp", holder: "Ana Gómez" } });

      const handoff = await request(app)
        .post(`/v1/agent/conversations/${conversationId}/handoff`)
        .set(key)
        .send({ businessId: s.businessId, reason: "reembolso", summary: "Canceló un pedido pagado por transferencia" })
        .expect(200);
      expect(handoff.body).toMatchObject({ ok: true, motivo: "reembolso", pedido: order.orderCode, hay_alguien: true });

      const caso = await db().conversationCase.findUniqueOrThrow({ where: { id: handoff.body.caso_id } });
      expect(caso).toMatchObject({ orderId: order.id, reason: "reembolso", status: "open", summary: "Canceló un pedido pagado por transferencia" });
      const refund = await db().orderRefund.findFirstOrThrow({ where: { orderId: order.id } });
      expect(refund.caseId).toBe(caso.id);
      const conversation = await db().whatsappConversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation).toMatchObject({ status: "handoff", handoffReason: "reembolso", currentCaseId: caso.id });
    });

    it("sin reembolso pendiente lo dice", async () => {
      const res = await request(app).patch("/v1/agent/refunds/current").set(key).send({ ...ids(), alias: "x" }).expect(200);
      expect(res.body).toMatchObject({ ok: false });
    });

    it("sin alias ni CBU es un error del request", async () => {
      await request(app).patch("/v1/agent/refunds/current").set(key).send({ ...ids(), holder: "Ana" }).expect(400);
    });

    it("con la derivación apagada no deriva", async () => {
      await db().botSettings.update({ where: { businessId: s.businessId }, data: { handoffEnabled: false } });
      const res = await request(app)
        .post(`/v1/agent/conversations/${conversationId}/handoff`)
        .set(key)
        .send({ businessId: s.businessId, reason: "queja" })
        .expect(200);
      expect(res.body.ok).toBe(false);
      expect((await db().whatsappConversation.findUniqueOrThrow({ where: { id: conversationId } })).status).toBe("open");
    });

    it("con un código de pedido, el caso queda atado a ese pedido", async () => {
      const order = await pedido();
      const res = await request(app)
        .post(`/v1/agent/conversations/${conversationId}/handoff`)
        .set(key)
        .send({ businessId: s.businessId, reason: "cancelacion", orderCode: `el ${order.orderCode.toLowerCase()} porfa` })
        .expect(200);
      expect(res.body.pedido).toBe(order.orderCode);
    });
  });

  describe("comprobante en ráfaga", () => {
    const mockDownload = () =>
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } })
      );

    it("sin URL usa la última imagen que mandó el cliente", async () => {
      const order = await pedido("transfer");
      await db().whatsappMessage.create({
        data: {
          businessId: s.businessId,
          conversationId,
          direction: "inbound",
          messageType: "image",
          content: "[imagen] comprobante",
          providerMessageId: "evt-img-1",
          rawPayload: { event: "message.received", message: { attachments: [{ type: "image", url: "https://zernio.com/m/1.jpg" }] } }
        }
      });
      const fetch = mockDownload();
      const res = await request(app).post("/v1/agent/payment-proofs").set(key).send(ids()).expect(200);
      expect(res.body).toMatchObject({ ok: true, duplicate: false, orderCode: order.orderCode });
      expect(String(fetch.mock.calls[0]![0])).toBe("https://zernio.com/m/1.jpg");
      const proof = await db().orderPaymentProof.findFirstOrThrow({ where: { orderId: order.id } });
      expect(proof.providerMessageId).toBe("evt-img-1");

      // El mismo adjunto no se guarda dos veces.
      const again = await request(app).post("/v1/agent/payment-proofs").set(key).send(ids()).expect(200);
      expect(again.body).toMatchObject({ ok: true, duplicate: true });
    });

    it("sin adjunto reciente lo dice", async () => {
      await pedido("transfer");
      const res = await request(app).post("/v1/agent/payment-proofs").set(key).send(ids()).expect(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/imagen o PDF/);
    });
  });

  describe("cancelar desde el dashboard", () => {
    it("devuelve el stock, registra quién canceló y no deja reactivarlo", async () => {
      const order = await pedido();
      await request(app)
        .patch(`/v1/orders/${order.id}/status`)
        .set(bearer(s.staff))
        .send({ status: "cancelled", note: "Sin repartidor" })
        .expect(200);
      expect(await stock()).toEqual({ burger: 10, panceta: 4 });
      const updated = await db().order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated).toMatchObject({ cancelledBy: "business_dashboard", cancellationReason: "Sin repartidor" });

      const reactivar = await request(app)
        .patch(`/v1/orders/${order.id}/status`)
        .set(bearer(s.owner))
        .send({ status: "preparing" })
        .expect(400);
      expect(JSON.stringify(reactivar.body)).toMatch(/no se puede reactivar/);
    });
  });
});
