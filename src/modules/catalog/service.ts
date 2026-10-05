import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../../config.js";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { isOpen } from "../businesses/service.js";
import { checkoutSchema, type CheckoutInput } from "../public/schemas.js";
import { buildOrderPayload, persistOrder } from "../orders/pricing.js";
import { catalogMessage, catalogReference, messageHash, quoteHash } from "./message.js";

export const prepareCatalogSchema = checkoutSchema.extend({ requestId: z.string().uuid() });
export const receiveCatalogSchema = z.object({
  businessId: z.string().uuid(), conversationId: z.string().uuid(), messageId: z.string().uuid()
});
interface StoredRequest {
  id: string; input_hash: string; input: CheckoutInput; quote_hash: string;
  message: string; message_hash: string; expires_at: Date; order_id: string | null; conversation_id: string | null;
}
const invalid = (message: string) => new ApiError("VALIDATION_ERROR", message);

function assertSelectedOptions(input: CheckoutInput, quote: Awaited<ReturnType<typeof buildOrderPayload>>) {
  input.items.forEach((item, index) => {
    const priced = new Set(quote.items[index]?.options.map(option => option.valueId));
    if (item.optionValueIds?.some(id => !priced.has(id))) {
      throw invalid("Una opción seleccionada ya no está disponible. Actualizá el carrito.");
    }
  });
}

export async function prepareCatalog(slug: string, data: z.infer<typeof prepareCatalogSchema>) {
  const { requestId, ...input } = data;
  return withDb(systemCtx, async tx => {
    const business = await tx.business.findFirst({ where: { slug, isActive: true } });
    if (!business) throw notFound("No encontramos este negocio.");
    const phone = business.whatsappPhone?.replace(/\D/g, "");
    if (!phone) throw invalid("El negocio todavía no tiene WhatsApp configurado.");
    if (!(await isOpen(tx, business.id))) throw new ApiError("BUSINESS_CLOSED", "El negocio está cerrado en este momento.");
    // Serialize identical prepare retries without creating an order or reserving stock.
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${business.id + requestId}, 0))`;
    const existing = await tx.$queryRaw<StoredRequest[]>`select * from public.catalog_requests where business_id = ${business.id}::uuid and request_id = ${requestId}::uuid`;
    const hash = messageHash(JSON.stringify(input));
    if (existing[0] && existing[0].input_hash !== hash) throw new ApiError("CONFLICT", "La solicitud cambió. Volvé a preparar el mensaje.");
    if (existing[0]?.order_id) throw new ApiError("CONFLICT", "Esta solicitud ya fue enviada. Consultá su seguimiento en WhatsApp.");
    let saved = existing[0];
    if (!saved || saved.expires_at.getTime() <= Date.now()) {
      const quote = await buildOrderPayload(tx, business, input);
      assertSelectedOptions(input, quote);
      const id = randomUUID();
      const message = catalogMessage(id, business.name, business.currency || "ARS", quote);
      if (message.length > 12000) throw invalid("El pedido es demasiado largo para enviarlo en un mensaje. Reducí las notas o la cantidad de productos distintos.");
      // Remove only the expired retry being replaced; other requests are untouched.
      if (saved) await tx.$executeRaw`delete from public.catalog_requests where id = ${saved.id}::uuid and order_id is null`;
      const expires = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await tx.$executeRaw`insert into public.catalog_requests
        (id, business_id, request_id, input_hash, input, quote_hash, message, message_hash, expires_at)
        values (${id}::uuid, ${business.id}::uuid, ${requestId}::uuid, ${hash}, ${JSON.stringify(input)}::jsonb,
          ${quoteHash(quote)}, ${message}, ${messageHash(message)}, ${expires})`;
      saved = { id, message, expires_at: expires } as StoredRequest;
    }
    return { reference: `WEB-${saved.id}`, message: saved.message, expiresAt: saved.expires_at.toISOString(), whatsappPhone: phone };
  });
}

export async function receiveCatalog(data: z.infer<typeof receiveCatalogSchema>) {
  try {
    return await withDb(systemCtx, async tx => {
      const { businessId, conversationId, messageId } = data;
      // Lock conversation first, then request, in a fixed order. No external I/O in the transaction.
      await tx.$queryRaw`select id from public.whatsapp_conversations where id = ${conversationId}::uuid and business_id = ${businessId}::uuid for update`;
      const conversation = await tx.whatsappConversation.findFirst({ where: { id: conversationId, businessId, status: "open" } });
      if (!conversation) throw invalid("La conversación no está disponible para el agente.");
      const inbound = await tx.whatsappMessage.findFirst({ where: { id: messageId, businessId, conversationId, direction: "inbound", messageType: "text" } });
      const reference = catalogReference(inbound?.content || "");
      if (!reference) throw invalid("El mensaje no contiene una solicitud del catálogo válida.");
      const rows = await tx.$queryRaw<StoredRequest[]>`select * from public.catalog_requests where id = ${reference}::uuid and business_id = ${businessId}::uuid for update`;
      const saved = rows[0];
      if (!saved || saved.message_hash !== messageHash(inbound!.content!)) throw invalid("El mensaje fue modificado o la referencia no pertenece a este negocio. Volvé al carrito y enviá el mensaje completo sin editarlo.");
      if (saved.conversation_id && saved.conversation_id !== conversationId) throw invalid("La solicitud ya está asociada a otra conversación.");
      const business = await tx.business.findFirst({ where: { id: businessId, isActive: true } });
      if (!business) throw notFound("El negocio no está disponible.");
      let order;
      if (saved.order_id) {
        order = await tx.order.findFirst({ where: { id: saved.order_id, businessId, whatsappConversationId: conversationId } });
        if (!order) throw invalid("No se pudo recuperar el pedido de esta solicitud.");
      } else {
        if (saved.expires_at.getTime() <= Date.now()) throw invalid("La solicitud venció. Volvé al carrito para actualizarla y enviarla nuevamente.");
        if (!(await isOpen(tx, businessId))) throw new ApiError("BUSINESS_CLOSED", "El local está cerrado. Volvé a enviar tu solicitud durante el horario de atención.");
        const draft = await tx.whatsappOrderDraft.findFirst({ where: { businessId, conversationId, status: "open" }, include: { items: true } });
        if (draft?.items.length) throw invalid("Hay otro pedido en preparación en esta conversación. Preguntá si quiere descartar ese borrador antes de tomar el del catálogo.");
        const quote = await buildOrderPayload(tx, business, checkoutSchema.parse(saved.input));
        assertSelectedOptions(saved.input, quote);
        if (quoteHash(quote) !== saved.quote_hash) throw invalid("Cambiaron los precios o las condiciones del pedido. Volvé al carrito, revisá el total actualizado y enviá una nueva solicitud. No se creó ningún pedido.");
        order = await persistOrder(tx, { ...quote, source: "web", conversationId });
        await tx.$executeRaw`update public.catalog_requests set order_id = ${order.id}::uuid, conversation_id = ${conversationId}::uuid where id = ${reference}::uuid and business_id = ${businessId}::uuid`;
      }
      const paymentMethod = saved.input.paymentMethod;
      const transfer = paymentMethod === "transfer" ? await tx.paymentSettings.findUnique({ where: { businessId } }) : null;
      return {
        ok: true, yaExistia: Boolean(saved.order_id), orderCode: order.orderCode, total: Number(order.total), status: order.status,
        paymentMethod, track_url: `${config.FRONT_URL.replace(/\/+$/, "")}/${business.slug}/order/${order.orderCode}`,
        ...(transfer ? { transferencia: { alias: transfer.transferAlias, cbu_cvu: transfer.transferCbu, titular: transfer.transferHolder, banco: transfer.transferBank } } : {})
      };
    });
  } catch (error) {
    // Catch outside withDb so failed persistence cannot commit a partially created order.
    if (error instanceof ApiError) return { ok: false, error: error.message };
    throw error;
  }
}
