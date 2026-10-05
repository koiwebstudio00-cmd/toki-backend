import { createHash } from "node:crypto";
import type { OrderPayload } from "../orders/pricing.js";

export const messageHash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
export const quoteHash = (payload: OrderPayload) => {
  const { orderCode: _code, ...quote } = payload;
  return messageHash(JSON.stringify(quote));
};

export function catalogMessage(reference: string, businessName: string, currency: string, p: OrderPayload) {
  const money = (n: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency }).format(n);
  return [
    `Hola, quiero pedir en ${businessName} desde el catálogo.`,
    `Referencia de solicitud: WEB-${reference}`,
    "", `Nombre: ${p.customerName}`, `Teléfono de contacto: ${p.customerPhone}`,
    "", "Productos:",
    ...p.items.flatMap(i => [
      `${i.quantity}x ${i.productName}${i.options.length ? ` (${i.options.map(o => `${o.optionName}: ${o.valueName}`).join(", ")})` : ""} — ${money(i.totalPrice)}`,
      ...(i.notes ? [`Nota del producto: ${i.notes}`] : [])
    ]),
    "", p.orderType === "delivery" ? `Delivery: ${p.deliveryAddress}` : "Retiro en el local",
    `Pago: ${p.paymentMethod === "cash" ? "Efectivo" : "Transferencia"}`,
    ...(p.couponCode ? [`Cupón: ${p.couponCode}`, `Descuento: ${money(p.discountTotal)}`] : []),
    `Envío: ${money(p.deliveryFee)}`, `Total a validar: ${money(p.total)}`,
    ...(p.notes ? [`Observaciones: ${p.notes}`] : []),
    "", "Solicito crear este pedido si los productos y el total siguen disponibles. Si hay cambios, consultame antes.",
    "Todavía no tengo un código de pedido."
  ].join("\n");
}

export function catalogReference(text: string) {
  return /^Referencia de solicitud: WEB-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im.exec(text)?.[1]?.toLowerCase();
}
