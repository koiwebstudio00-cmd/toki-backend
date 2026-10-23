import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDb } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import type { BusinessScope } from "../../lib/request.js";
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "Usá punto decimal sin separadores de miles.").transform(Number).pipe(z.number().max(999999999));
const rowSchema = z.object({
 referencia:z.string().trim().min(1).max(120), fecha:z.string().datetime({offset:true}), cliente:z.string().trim().min(1).max(150), telefono:z.string().max(40),
 estado:z.enum(["pending","confirmed","preparing","out_for_delivery","delivered","cancelled"]), origen:z.enum(["web","manual","whatsapp"]), entrega:z.enum(["delivery","takeaway"]),
 metodo_pago:z.enum(["cash","transfer","mercadopago"]), pago:z.enum(["pending","paid","failed","refunded"]), direccion:z.string().max(500), notas:z.string().max(1000),
 envio:money, descuento:money, producto:z.string().trim().min(1).max(300), cantidad:z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(10000)), precio:money, importe_producto:money.or(z.literal("")).optional(), subtotal:money.or(z.literal("")).optional(), total:money.or(z.literal("")).optional(), detalle:z.string().max(1000)
});
type Archived={id:string;payload:Record<string,unknown>};
export async function list(scope:BusinessScope,page:number){return withDb(scope.ctx,async tx=>{
 const data=await tx.$queryRaw<Archived[]>`SELECT id,payload FROM public.imported_orders WHERE business_id=${scope.businessId}::uuid ORDER BY ordered_at DESC,id LIMIT 100 OFFSET ${(page-1)*100}`;
 const [count]=await tx.$queryRaw<{total:number}[]>`SELECT count(*)::int AS total FROM public.imported_orders WHERE business_id=${scope.businessId}::uuid`;
 return {data:data.map(r=>({...r.payload,id:r.id})),meta:{pages:Math.max(1,Math.ceil((count?.total || 0)/100)),total:(count?.total || 0)}};
});}
export async function get(scope:BusinessScope,id:string){return withDb(scope.ctx,async tx=>{
 const [row]=await tx.$queryRaw<Archived[]>`SELECT id,payload FROM public.imported_orders WHERE id=${id}::uuid AND business_id=${scope.businessId}::uuid`;
 if(!row)throw notFound();return {...row.payload,id:row.id};
});}
export async function importRows(scope:BusinessScope,rows:Record<string,string>[],preview:boolean){
 const groups=new Map<string,{header:string;first:z.infer<typeof rowSchema>;items:Record<string,unknown>[];subtotal:number}>();
 const issues:{row:number;message:string}[]=[];
 rows.forEach((row,index)=>{
  const parsed=rowSchema.safeParse(row);
  if(!parsed.success){issues.push({row:index+2,message:parsed.error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join(" ")});return;}
  const r=parsed.data;const {producto,cantidad,precio,importe_producto,detalle,...header}=r;
  const group=groups.get(r.referencia)||{header:JSON.stringify(header),first:r,items:[],subtotal:0};
  if(group.header!==JSON.stringify(header)){issues.push({row:index+2,message:"La referencia se repite con datos del pedido diferentes."});return;}
  const totalPrice=typeof importe_producto === "number" ? importe_producto : Math.round(cantidad*precio*100)/100;
  group.items.push({id:randomUUID(),productName:producto,quantity:cantidad,unitPrice:precio,totalPrice,notes:detalle,options:[]});
  group.subtotal=Math.round((group.subtotal+totalPrice)*100)/100;groups.set(r.referencia,group);
 });
 for(const [reference,g] of groups)if(g.first.descuento>g.subtotal||g.subtotal+g.first.envio>999999999||(typeof g.first.subtotal === "number" && Math.abs(g.first.subtotal-g.subtotal)>0.001)||(typeof g.first.total === "number" && Math.abs(g.first.total-(g.subtotal+g.first.envio-g.first.descuento))>0.001))issues.push({row:rows.findIndex(r=>r.referencia===reference)+2,message:"Revisá el subtotal, total y descuento: deben coincidir con los importes de productos y envío."});
 if(issues.length)return {created:0,skipped:0,total:groups.size,issues};
 return withDb(scope.ctx,async tx=>{
  let created=0,skipped=0;
  for(const [reference,g]of groups){
   const existing=await tx.$queryRaw<{id:string}[]>`SELECT id FROM public.imported_orders WHERE business_id=${scope.businessId}::uuid AND external_id=${reference}`;
   const liveId=reference.startsWith("toki:")?z.string().uuid().safeParse(reference.slice(5)):null;
   const live=liveId?.success?await tx.order.findFirst({where:{id:liveId.data,businessId:scope.businessId},select:{id:true}}):null;
   if(existing.length||live){skipped++;continue;}if(preview){created++;continue;}
   const r=g.first;
   const payload={businessId:scope.businessId,imported:true,importReference:reference,orderCode:reference,createdAt:r.fecha,updatedAt:r.fecha,customerName:r.cliente,customerPhone:r.telefono,customerId:null,status:r.estado,source:r.origen,orderType:r.entrega,paymentMethod:r.metodo_pago,paymentStatus:r.pago,deliveryAddress:r.direccion,notes:r.notas,subtotal:g.subtotal,deliveryFee:r.envio,discountTotal:r.descuento,total:Math.round((g.subtotal+r.envio-r.descuento)*100)/100,items:g.items,statusHistory:[],payments:[]};
   const saved=await tx.$executeRaw`INSERT INTO public.imported_orders(business_id,external_id,ordered_at,payload) VALUES(${scope.businessId}::uuid,${reference},${new Date(r.fecha)},${JSON.stringify(payload)}::jsonb) ON CONFLICT(business_id,external_id) DO NOTHING`;
   if(saved)created++;else skipped++;
  }return {created,skipped,total:groups.size,issues:[]};
 });
}
