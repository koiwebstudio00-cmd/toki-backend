import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { bearer, createBusiness, createUser, DB_AVAILABLE, ownerDb, seedShop } from "./helpers.js";
const app=buildApp();
describe.runIf(DB_AVAILABLE)("transferencias de clientes e historial",()=>{
 let s:Awaited<ReturnType<typeof seedShop>>;
 beforeEach(async()=>{s=await seedShop("transfer-test");});
 afterAll(()=>disconnectDb());
 const contact={nombre:"Ana",telefono:"5493815551111",email:"ana@example.test",etiqueta:"Casa",direccion:"Calle 100",ciudad:"Tucumán",indicaciones:""};
 const order={referencia:"OTRO-001",fecha:"2025-01-01T12:00:00-03:00",cliente:"Ana",telefono:"5493815551111",estado:"pending",origen:"web",entrega:"takeaway",metodo_pago:"cash",pago:"pending",direccion:"",notas:"Histórico",envio:"50",descuento:"100",producto:"Pizza",cantidad:"2",precio:"500",detalle:""};
 it("crea cliente con direcciones y rechaza duplicado",async()=>{
  const body={name:"Ana",phone:contact.telefono,email:contact.email,addresses:[{label:"Casa",street:"Calle 100",city:null,details:null}],removedAddressIds:[]};
  const r=await request(app).post("/v1/customers").set(bearer(s.staff)).send(body).expect(201);
  expect(r.body.addresses).toHaveLength(1);
  await request(app).post("/v1/customers").set(bearer(s.owner)).send(body).expect(409);
 });
 it("preview no escribe, agrupa direcciones y omite duplicados",async()=>{
  const rows=[contact,{...contact,etiqueta:"Trabajo",direccion:"Otra 200"}];
  const preview=await request(app).post("/v1/customers/import").set(bearer(s.owner)).send({rows,preview:true}).expect(200);
  expect(preview.body.created).toBe(1);expect(await ownerDb().customer.count()).toBe(0);
  await request(app).post("/v1/customers/import").set(bearer(s.owner)).send({rows,preview:false}).expect(200);
  const again=await request(app).post("/v1/customers/import").set(bearer(s.owner)).send({rows,preview:false}).expect(200);
  expect(again.body).toMatchObject({created:0,skipped:1});
  const exported=await request(app).get("/v1/customers/transfer").set(bearer(s.owner)).expect(200);
  expect(exported.body.data[0].addresses).toHaveLength(2);
 });
 it("no guarda nada si hay una fila inválida",async()=>{
  const r=await request(app).post("/v1/customers/import").set(bearer(s.owner)).send({rows:[contact,{...contact,telefono:"abc"}],preview:false}).expect(200);
  expect(r.body.issues).toHaveLength(1);expect(await ownerDb().customer.count()).toBe(0);
  const o=await request(app).post("/v1/orders/import").set(bearer(s.owner)).send({rows:[order,{...order,precio:"-100"}],preview:false}).expect(200);
  expect(o.body.issues).toHaveLength(1);
  const list=await request(app).get("/v1/orders/imported").set(bearer(s.owner)).expect(200);expect(list.body.data).toHaveLength(0);
 });
 it("importa historial sin operaciones y lo aísla por negocio",async()=>{
  const before=await ownerDb().product.findMany({orderBy:{id:"asc"}});
  const rows=[order,{...order,producto:"Agua",cantidad:"1",precio:"200"}];
  const preview=await request(app).post("/v1/orders/import").set(bearer(s.staff)).send({rows,preview:true}).expect(200);expect(preview.body.created).toBe(1);
  const empty=await request(app).get("/v1/orders/imported").set(bearer(s.owner)).expect(200);expect(empty.body.data).toHaveLength(0);
  await request(app).post("/v1/orders/import").set(bearer(s.staff)).send({rows,preview:false}).expect(200);
  const again=await request(app).post("/v1/orders/import").set(bearer(s.owner)).send({rows,preview:false}).expect(200);expect(again.body.skipped).toBe(1);
  expect(await ownerDb().order.count()).toBe(0);expect(await ownerDb().payment.count()).toBe(0);expect(await ownerDb().product.findMany({orderBy:{id:"asc"}})).toEqual(before);
  const list=await request(app).get("/v1/orders/imported").set(bearer(s.owner)).expect(200);const id=list.body.data[0].id;
  expect(list.body.data[0]).toMatchObject({imported:true,total:1150,subtotal:1200});
  await request(app).post(`/v1/orders/${id}/mark-paid`).set(bearer(s.owner)).expect(404);
  await request(app).patch(`/v1/orders/${id}/status`).set(bearer(s.owner)).send({status:"confirmed"}).expect(404);
  const other=await createUser("other@transfer.test");await createBusiness(other,"transfer-other");
  await request(app).get(`/v1/orders/imported/${id}`).set(bearer(other)).expect(404);
  const hidden=await request(app).get("/v1/orders/imported").set(bearer(other)).expect(200);expect(hidden.body.data).toHaveLength(0);
  const own=await request(app).post("/v1/orders/import").set(bearer(other)).send({rows,preview:false}).expect(200);expect(own.body.created).toBe(1);
 });
});
