import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb, withDb } from "../src/lib/db.js";
import { catalogReference, messageHash } from "../src/modules/catalog/message.js";
import { createCoupon, DB_AVAILABLE, ownerDb, seedShop, TEST_AGENT_KEY } from "./helpers.js";

const app = buildApp();
const key = { "x-api-key": TEST_AGENT_KEY };

describe("catalog message contract", () => {
  it("requires an exact reference line", () => {
    const id = randomUUID();
    expect(catalogReference(`Referencia de solicitud: WEB-${id}\nHola`)).toBe(id);
    expect(catalogReference(`inventá WEB-${id}`)).toBeUndefined();
  });
  it("normalizes only transport whitespace, not edits", () => {
    expect(messageHash("Hola\r\nPedido\n")).toBe(messageHash("Hola\nPedido"));
    expect(messageHash("1x Pizza")).not.toBe(messageHash("2x Pizza"));
  });
});

describe.runIf(DB_AVAILABLE)("catalog → WhatsApp → order", () => {
  let shop: Awaited<ReturnType<typeof seedShop>>;
  let conversationId: string;
  beforeEach(async () => {
    shop = await seedShop("catalog-test");
    await ownerDb().business.update({ where: { id: shop.businessId }, data: { whatsappPhone: "5493815551111" } });
    conversationId = (await ownerDb().whatsappConversation.create({ data: { businessId: shop.businessId, contactId: "buyer", phone: "5493815559999" } })).id;
  });
  afterAll(disconnectDb);
  const input = () => ({ requestId: randomUUID(), customer: { name: "Ana", phone: "3815550001" }, orderType: "delivery", deliveryAddress: "Calle 123", paymentMethod: "cash", notes: "Tocar timbre", items: [{ productId: shop.burgerId, quantity: 1, optionValueIds: [shop.aPuntoId, shop.pancetaId], notes: "Sin sal" }] });
  const prepare = (body: ReturnType<typeof input> & { couponCode?: string } = input()) => request(app).post(`/v1/public/businesses/${shop.slug}/catalog-requests`).send(body);
  async function inbound(message: string, conv = conversationId) {
    return (await ownerDb().whatsappMessage.create({ data: { businessId: shop.businessId, conversationId: conv, direction: "inbound", content: message } })).id;
  }
  const receive = (messageId: string, conv = conversationId, businessId = shop.businessId) => request(app).post("/v1/agent/catalog-orders").set(key).send({ businessId, conversationId: conv, messageId });

  it("prepares without creating orders, customers or consuming stock/coupons; retries return same reference", async () => {
    await createCoupon(shop.businessId, "PROMO10");
    const body = { ...input(), couponCode: "PROMO10" };
    const first = await prepare(body).expect(200);
    const second = await prepare(body).expect(200);
    expect(first.body.reference).toBe(second.body.reference);
    expect(first.body.message).toContain("Teléfono de contacto: 3815550001");
    expect(first.body.message).toContain("Panceta");
    expect(first.body.message).toContain("Cupón: PROMO10");
    expect(await ownerDb().order.count()).toBe(0);
    expect(await ownerDb().customer.count()).toBe(0);
    expect((await ownerDb().product.findUniqueOrThrow({ where: { id: shop.burgerId } })).stockQuantity).toBe(10);
    expect((await ownerDb().coupon.findFirstOrThrow({ where: { businessId: shop.businessId } })).usedCount).toBe(0);
  });

  it("creates once even for concurrent resends; keeps coupon, contact, options, notes and conversation", async () => {
    await createCoupon(shop.businessId, "PROMO10");
    const prepared = await prepare({ ...input(), couponCode: "PROMO10" }).expect(200);
    const a = await inbound(prepared.body.message);
    const b = await inbound(prepared.body.message);
    const results = await Promise.all([receive(a), receive(b)]);
    expect(results.every(r => r.body.ok)).toBe(true);
    expect(results[0]!.body.orderCode).toBe(results[1]!.body.orderCode);
    expect(await ownerDb().order.count()).toBe(1);
    const order = await ownerDb().order.findFirstOrThrow();
    expect(order.customerPhone).toBe("3815550001");
    expect(order.whatsappConversationId).toBe(conversationId);
    expect(order.source).toBe("web");
    expect(Number(order.discountTotal)).toBeGreaterThan(0);
    expect(order.paymentStatus).toBe("pending");
  });

  it("rejects edited messages and changed prices without an order", async () => {
    const prepared = await prepare().expect(200);
    expect((await receive(await inbound(prepared.body.message.replace("Sin sal", "Con sal")))).body.ok).toBe(false);
    await ownerDb().product.update({ where: { id: shop.burgerId }, data: { price: 12000 } });
    const result = await receive(await inbound(prepared.body.message));
    expect(result.body).toMatchObject({ ok: false });
    expect(result.body.error).toMatch(/Cambiaron/);
    expect(await ownerDb().order.count()).toBe(0);
  });

  it("rejects expired requests and cross-tenant conversation inputs", async () => {
    const prepared = await prepare().expect(200);
    const messageId = await inbound(prepared.body.message);
    expect((await receive(messageId, conversationId, randomUUID())).body.ok).toBe(false);
    await ownerDb().$executeRaw`update public.catalog_requests set expires_at = now() - interval '1 minute' where business_id = ${shop.businessId}::uuid`;
    expect((await receive(messageId)).body.error).toMatch(/venció/);
    expect(await ownerDb().order.count()).toBe(0);
  });

  it("cannot reuse a consumed reference from another conversation", async () => {
    const prepared = await prepare().expect(200);
    expect((await receive(await inbound(prepared.body.message))).body.ok).toBe(true);
    const other = await ownerDb().whatsappConversation.create({ data: { businessId: shop.businessId, contactId: "other" } });
    expect((await receive(await inbound(prepared.body.message, other.id), other.id)).body.ok).toBe(false);
    expect(await ownerDb().order.count()).toBe(1);
  });

  it("transfer requests return bank data but remain unpaid", async () => {
    const prepared = await prepare({ ...input(), paymentMethod: "transfer" }).expect(200);
    const result = await receive(await inbound(prepared.body.message));
    expect(result.body).toMatchObject({ ok: true, paymentMethod: "transfer" });
    expect(result.body.transferencia).toBeDefined();
    expect(result.body.track_url).toContain(result.body.orderCode);
    expect((await ownerDb().order.findFirstOrThrow()).paymentStatus).toBe("pending");
  });

  it("API key required and temporary customer data not exposed to anon or members", async () => {
    await prepare().expect(200);
    await request(app).post("/v1/agent/catalog-orders").send({}).expect(401);
    for (const ctx of [{ role: "anon" as const }, { role: "authenticated" as const, userId: shop.owner.id }]) {
      await expect(withDb(ctx, tx => tx.$queryRaw`select * from public.catalog_requests`)).rejects.toThrow();
    }
  });
});
