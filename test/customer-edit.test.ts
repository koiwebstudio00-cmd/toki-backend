import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { bearer, createBusiness, createUser, DB_AVAILABLE, ownerDb, seedShop } from "./helpers.js";

const app = buildApp();
describe.runIf(DB_AVAILABLE)("editar cliente", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;
  let id: string;
  let addressId: string;
  const body = () => ({ name: "Ana editada", phone: "+54 9 381 555-0001", email: "ana@example.test", addresses: [], removedAddressIds: [] });
  beforeEach(async () => {
    s = await seedShop("customer-edit");
    const customer = await ownerDb().customer.create({ data: { businessId: s.businessId, name: "Ana", phone: "5493815550000" } });
    id = customer.id;
    const address = await ownerDb().customerAddress.create({ data: { customerId: id, businessId: s.businessId, street: "Calle 100" } });
    addressId = address.id;
  });
  afterAll(() => disconnectDb());
  it("guarda contacto y direcciones; permite al staff y conserva pedidos históricos", async () => {
    const order = await ownerDb().order.create({ data: { businessId: s.businessId, customerId: id, orderCode: "TK-100001", customerName: "Ana", customerPhone: "5493815550000", orderType: "takeaway", subtotal: 1000, total: 1000 } });
    const res = await request(app).patch(`/v1/customers/${id}`).set(bearer(s.staff)).send({ ...body(), addresses: [{ id: addressId, label: "Casa", street: "Calle 200", city: "Tucumán", details: "Piso 1" }, { label: "Trabajo", street: "Otra 300", city: null, details: null }] }).expect(200);
    expect(res.body).toMatchObject({ name: "Ana editada", phone: "5493815550001", email: "ana@example.test" });
    expect(res.body.addresses).toHaveLength(2);
    const persisted = await request(app).get(`/v1/customers/${id}`).set(bearer(s.owner)).expect(200);
    expect(persisted.body.addresses.find((a: { id: string }) => a.id === addressId).street).toBe("Calle 200");
    expect(await ownerDb().order.findUnique({ where: { id: order.id } })).toMatchObject({ customerName: "Ana", customerPhone: "5493815550000" });
  });
  it("borra solo direcciones indicadas y permite limpiar email", async () => {
    await request(app).patch(`/v1/customers/${id}`).set(bearer(s.owner)).send({ ...body(), email: "", removedAddressIds: [addressId] }).expect(200);
    expect(await ownerDb().customerAddress.count({ where: { customerId: id } })).toBe(0);
    expect((await ownerDb().customer.findUnique({ where: { id } }))?.email).toBeNull();
  });
  it("rechaza teléfonos repetidos y revierte todo", async () => {
    await ownerDb().customer.create({ data: { businessId: s.businessId, name: "Otra", phone: "5493815550001" } });
    await request(app).patch(`/v1/customers/${id}`).set(bearer(s.owner)).send({ ...body(), removedAddressIds: [addressId] }).expect(409);
    expect((await ownerDb().customer.findUnique({ where: { id } }))?.name).toBe("Ana");
    expect(await ownerDb().customerAddress.count({ where: { customerId: id } })).toBe(1);
  });
  it("rechaza cliente y direcciones de otros negocios y otros clientes", async () => {
    const other = await createUser("other@edit.test");
    const businessId = await createBusiness(other, "other-edit");
    const customer = await ownerDb().customer.create({ data: { businessId, name: "Otra", phone: "5493815550001" } });
    const foreign = await ownerDb().customerAddress.create({ data: { businessId, customerId: customer.id, street: "Ajena 100" } });
    await request(app).patch(`/v1/customers/${id}`).set(bearer(other)).send(body()).expect(404);
    await request(app).patch(`/v1/customers/${id}`).set(bearer(s.owner)).send({ ...body(), removedAddressIds: [foreign.id] }).expect(404);
    const sibling = await ownerDb().customer.create({ data: { businessId: s.businessId, name: "Vecino", phone: "5493815550022" } });
    const siblingAddress = await ownerDb().customerAddress.create({ data: { businessId: s.businessId, customerId: sibling.id, street: "Vecina 100" } });
    await request(app).patch(`/v1/customers/${id}`).set(bearer(s.owner)).send({ ...body(), addresses: [{ id: siblingAddress.id, label: "Casa", street: "No cambiar", city: null, details: null }] }).expect(404);
    expect((await ownerDb().customer.findUnique({ where: { id } }))?.name).toBe("Ana");
    expect((await ownerDb().customerAddress.findUnique({ where: { id: siblingAddress.id } }))?.street).toBe("Vecina 100");
  });
  it.each([{ name: " " }, { phone: "abc" }, { email: "inválido" }, { addresses: [{ label: "Casa", street: "", city: null, details: null }] }])("valida datos inválidos %j", async invalid => {
    await request(app).patch(`/v1/customers/${id}`).set(bearer(s.owner)).send({ ...body(), ...invalid }).expect(400);
  });
});
