// Herramientas del agente de WhatsApp (n8n) — docs/api.md §14.
//
// Todo corre con contexto `service_role`: quien llama se autenticó con la API
// key, no es un usuario. La autorización real la hacen las funciones SQL, que
// verifican que la conversación pertenezca al negocio del request.
//
// Las respuestas son las mismas que devolvían las RPC `agent_*`, así el prompt
// del agente no cambia al migrar.
import { Prisma } from "@prisma/client";
import { systemCtx, type Tx, withDb } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import { newPaymentProofKey, putObject } from "../../lib/r2.js";
import { zernioDownload } from "../../lib/zernio.js";
import { isOpen } from "../businesses/service.js";
import { buildOrderPayload, persistOrder, type PricingItem } from "../orders/pricing.js";
import type {
  DraftAddItemInput,
  DraftDetailsInput,
  LogMessageInput,
  OrderDetailsInput,
  PaymentProofInput,
  UpsertConversationInput
} from "./schemas.js";

type Json = Record<string, unknown>;

/** Toda RPC agent_* devuelve un jsonb: un solo helper para todas. */
async function rpc(sql: Prisma.Sql): Promise<Json> {
  const rows = await withDb(systemCtx, (tx) => tx.$queryRaw<{ result: Json }[]>(sql));
  return rows[0]?.result ?? { ok: false, error: "No se pudo completar la acción." };
}

// ── Integración y conversación ──────────────────────────────────────────────

/** El webhook llega con la cuenta de Zernio: acá se resuelve de qué negocio es. */
export async function resolveIntegration(accountId: string) {
  return withDb(systemCtx, async (tx) => {
    const integration = await tx.whatsappIntegration.findFirst({
      where: { providerExternalId: accountId, isActive: true },
      select: {
        businessId: true,
        business: { select: { id: true, name: true, slug: true, timezone: true, currency: true, isActive: true } }
      }
    });
    if (!integration?.business?.isActive) throw notFound("No hay ningún negocio conectado a esta cuenta.");
    const bot = await tx.botSettings.findUnique({
      where: { businessId: integration.businessId },
      select: { isEnabled: true, botName: true, tone: true, fallbackMessage: true, handoffEnabled: true }
    });
    return {
      businessId: integration.businessId,
      business: integration.business,
      botEnabled: bot?.isEnabled ?? false,
      bot: bot ?? null
    };
  });
}

/** Upsert por (business_id, contact_id). No pisa `status`: si el humano tomó la conversación, sigue tomada. */
export async function upsertConversation(input: UpsertConversationInput) {
  const row = await withDb(systemCtx, (tx) =>
    tx.whatsappConversation.upsert({
      where: { businessId_contactId: { businessId: input.businessId, contactId: input.contactId } },
      create: {
        businessId: input.businessId,
        contactId: input.contactId,
        phone: input.phone ?? null,
        lastMessageAt: new Date()
      },
      update: {
        ...(input.phone ? { phone: input.phone } : {}),
        lastMessageAt: new Date()
      }
    })
  );
  return {
    conversationId: row.id,
    contactId: row.contactId,
    phone: row.phone,
    status: row.status,
    handoffReason: row.handoffReason
  };
}

/**
 * Guarda el mensaje. El webhook se reintenta, así que un `providerMessageId`
 * repetido no es un error: se responde `duplicate` y el agente sigue.
 */
export async function logMessage(input: LogMessageInput) {
  try {
    const row = await withDb(systemCtx, async (tx) => {
      const message = await tx.whatsappMessage.create({
        data: {
          businessId: input.businessId,
          conversationId: input.conversationId,
          direction: input.direction,
          messageType: input.messageType,
          content: input.content ?? null,
          providerMessageId: input.providerMessageId ?? null,
          rawPayload: (input.rawPayload ?? undefined) as Prisma.InputJsonValue | undefined,
          aiIntent: input.aiIntent ?? null
        },
        select: { id: true, createdAt: true }
      });
      await tx.whatsappConversation.updateMany({
        where: { id: input.conversationId, businessId: input.businessId },
        data: { lastMessageAt: message.createdAt }
      });
      return message;
    });
    return { duplicate: false as const, id: row.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { duplicate: true as const };
    }
    throw err;
  }
}

// ── Lecturas ────────────────────────────────────────────────────────────────

export const context = (businessId: string, conversationId: string, k: number) =>
  rpc(Prisma.sql`select public.agent_context(${businessId}::uuid, ${conversationId}::uuid, ${k}) as result`);

export const searchProducts = (businessId: string, q: string | undefined, limit: number) =>
  rpc(Prisma.sql`select public.agent_search_products(${businessId}::uuid, ${q ?? null}, ${limit}) as result`);

export const productDetail = (businessId: string, productId: string) =>
  rpc(Prisma.sql`select public.agent_product_detail(${businessId}::uuid, ${productId}::uuid) as result`);

export const searchFaq = (businessId: string, q: string | undefined, limit: number) =>
  rpc(Prisma.sql`select public.agent_search_faq(${businessId}::uuid, ${q ?? ""}, ${limit}) as result`);

export const orderStatus = (businessId: string, conversationId: string, orderCode?: string) =>
  rpc(
    Prisma.sql`select public.agent_order_status(${businessId}::uuid, ${conversationId}::uuid, ${orderCode ?? null}) as result`
  );

// ── Borrador ────────────────────────────────────────────────────────────────

export const draftGet = (businessId: string, conversationId: string) =>
  rpc(Prisma.sql`select public.agent_draft_get(${businessId}::uuid, ${conversationId}::uuid) as result`);

export const draftAddItem = (i: DraftAddItemInput) =>
  rpc(Prisma.sql`select public.agent_draft_add_item(
    ${i.businessId}::uuid, ${i.conversationId}::uuid, ${i.productId}::uuid,
    ${i.quantity}, ${i.optionValueIds}::uuid[], ${i.notes ?? null}) as result`);

export const draftRemoveItem = (businessId: string, conversationId: string, itemId: string) =>
  rpc(
    Prisma.sql`select public.agent_draft_remove_item(${businessId}::uuid, ${conversationId}::uuid, ${itemId}::uuid) as result`
  );

export const draftSetDetails = (i: DraftDetailsInput) =>
  rpc(Prisma.sql`select public.agent_draft_set_details(
    ${i.businessId}::uuid, ${i.conversationId}::uuid, ${i.customerName ?? null}, ${i.orderType ?? null},
    ${i.deliveryAddress ?? null}, ${i.paymentMethod ?? null}, ${i.notes ?? null}) as result`);

export const draftCancel = (businessId: string, conversationId: string) =>
  rpc(Prisma.sql`select public.agent_draft_cancel(${businessId}::uuid, ${conversationId}::uuid) as result`);

// ── Confirmación del pedido ─────────────────────────────────────────────────

interface DraftRow {
  id: string;
  status: string;
  orderId: string | null;
  customerName: string | null;
  orderType: "delivery" | "takeaway" | null;
  deliveryAddress: string | null;
  paymentMethod: "cash" | "transfer" | "mercadopago" | null;
  notes: string | null;
}

const fail = (error: string) => ({ ok: false as const, error });

/**
 * Confirma el borrador que el agente fue armando. Port de `confirmWhatsAppDraft`
 * de la Edge Function `create-order`.
 *
 * El request NO trae items ni precios: trae la conversación. Los items se leen
 * del borrador, así que ni el modelo ni quien llame puede inventar un producto,
 * un precio ni una cantidad. Los errores vuelven como `{ ok: false, error }`
 * legible: el agente se lo explica al cliente en vez de decir que se confirmó.
 */
export async function confirmDraft(businessId: string, conversationId: string) {
  return withDb(systemCtx, async (tx) => {
    const draft = await tx.whatsappOrderDraft.findFirst({
      where: { conversationId, businessId },
      include: { items: { orderBy: { createdAt: "asc" } } }
    });
    if (!draft) return fail("No hay ningún pedido armado en esta conversación.");

    // Idempotencia: un reintento del webhook, o un segundo "confirmá" del
    // cliente, devuelve el pedido que ya existe en vez de crear otro.
    if (draft.status === "confirmed" && draft.orderId) {
      const existing = await tx.order.findUnique({
        where: { id: draft.orderId },
        select: { orderCode: true, status: true, total: true }
      });
      if (existing) {
        return { ok: true as const, yaExistia: true, orderCode: existing.orderCode, status: existing.status, total: Number(existing.total) };
      }
    }
    if (draft.status !== "open") return fail("Ese pedido ya se cerró.");

    const d = draft as unknown as DraftRow;
    if (!draft.items.length) return fail("El pedido está vacío.");
    if (!d.customerName?.trim()) return fail("Falta el nombre de quien hace el pedido.");
    if (!d.orderType) return fail("Falta saber si es delivery o retiro.");
    if (!d.paymentMethod) return fail("Falta el método de pago.");
    if (d.orderType === "delivery" && !d.deliveryAddress?.trim()) return fail("Falta la dirección de entrega.");

    const conversation = await tx.whatsappConversation.findFirst({
      where: { id: conversationId, businessId },
      select: { phone: true, contactId: true }
    });
    const business = await tx.business.findFirst({ where: { id: businessId, isActive: true } });
    if (!business) return fail("El negocio no está disponible.");
    if (!(await isOpen(tx, businessId))) {
      return fail("El local está cerrado en este momento, no puedo confirmar el pedido.");
    }

    const items: PricingItem[] = draft.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      optionValueIds: item.optionValueIds,
      notes: item.notes
    }));

    try {
      const payload = await buildOrderPayload(tx, business, {
        customer: {
          name: d.customerName,
          // El teléfono puede faltar (WhatsApp permite escribir sin exponerlo):
          // queda el identificador del contacto, que es lo único con lo que el
          // negocio puede volver a encontrarlo.
          phone: conversation?.phone || conversation?.contactId || ""
        },
        orderType: d.orderType,
        deliveryAddress: d.deliveryAddress,
        notes: d.notes,
        paymentMethod: d.paymentMethod,
        items
      });
      const order = await persistOrder(tx, { ...payload, source: "whatsapp", conversationId });
      await tx.whatsappOrderDraft.update({
        where: { id: draft.id },
        data: { status: "confirmed", orderId: order.id }
      });
      return { ok: true as const, ...order };
    } catch (err) {
      // Mensaje legible para el cliente final, no un stack.
      return fail(err instanceof Error ? err.message : "No se pudo confirmar el pedido.");
    }
  });
}

// ── Pedido ya confirmado ────────────────────────────────────────────────────

export const updateOrderDetails = (i: OrderDetailsInput, orderCode: string) =>
  rpc(Prisma.sql`select public.agent_order_update_details(
    ${i.businessId}::uuid, ${i.conversationId}::uuid, ${orderCode},
    ${i.orderType ?? null}, ${i.deliveryAddress ?? null}, ${i.paymentMethod ?? null}) as result`);

export const addDraftItemsToOrder = (businessId: string, conversationId: string, orderCode: string) =>
  rpc(
    Prisma.sql`select public.agent_order_add_draft_items(${businessId}::uuid, ${conversationId}::uuid, ${orderCode}) as result`
  );

export const handoff = (businessId: string, conversationId: string, reason?: string | null) =>
  rpc(
    Prisma.sql`select public.agent_conversation_handoff(${businessId}::uuid, ${conversationId}::uuid, ${reason ?? null}) as result`
  );

// ── Comprobantes de pago ────────────────────────────────────────────────────

const PROOF_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf"
};

/** El comprobante se guarda contra un pedido: el del código, o el último de la conversación. */
async function resolveOrder(tx: Tx, businessId: string, conversationId: string, orderCode?: string | null) {
  if (orderCode) {
    return tx.order.findFirst({
      where: { businessId, orderCode: orderCode.toUpperCase() },
      select: { id: true, orderCode: true }
    });
  }
  return tx.order.findFirst({
    where: { businessId, whatsappConversationId: conversationId, status: { not: "cancelled" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, orderCode: true }
  });
}

/**
 * Baja el adjunto de Zernio, lo sube al bucket PRIVADO y deja la fila para que
 * el negocio lo revise. Solo se guarda si hay un pedido al que atarlo: un
 * comprobante suelto no le sirve a nadie.
 */
export async function savePaymentProof(input: PaymentProofInput) {
  const prepared = await withDb(systemCtx, async (tx) => {
    if (input.providerMessageId) {
      const already = await tx.orderPaymentProof.findFirst({
        where: { businessId: input.businessId, providerMessageId: input.providerMessageId },
        select: { id: true }
      });
      if (already) return { kind: "duplicate" as const, id: already.id };
    }
    const conversation = await tx.whatsappConversation.count({
      where: { id: input.conversationId, businessId: input.businessId }
    });
    if (conversation === 0) return { kind: "error" as const, error: "Conversación inválida." };

    const order = await resolveOrder(tx, input.businessId, input.conversationId, input.orderCode);
    if (!order) return { kind: "error" as const, error: "No encontré un pedido al que asociar el comprobante." };
    return { kind: "ready" as const, order };
  });

  if (prepared.kind === "duplicate") return { ok: true as const, duplicate: true, id: prepared.id };
  if (prepared.kind === "error") return fail(prepared.error);

  // La descarga y la subida quedan FUERA de la transacción: son llamadas de red.
  const { body, contentType } = await zernioDownload(input.mediaUrl);
  const extension = PROOF_EXTENSIONS[contentType.split(";")[0]!.trim()];
  if (!extension) return fail("El archivo no es una imagen ni un PDF.");

  const key = newPaymentProofKey(input.businessId, prepared.order.orderCode, extension);
  await putObject("private", key, body, contentType);

  try {
    const row = await withDb(systemCtx, (tx) =>
      tx.orderPaymentProof.create({
        data: {
          businessId: input.businessId,
          orderId: prepared.order.id,
          conversationId: input.conversationId,
          storagePath: key,
          mediaType: input.mediaType,
          providerMessageId: input.providerMessageId ?? null
        },
        select: { id: true }
      })
    );
    return { ok: true as const, duplicate: false, id: row.id, orderCode: prepared.order.orderCode };
  } catch (err) {
    // Carrera entre dos reintentos del webhook: el índice único decide.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: true as const, duplicate: true };
    }
    throw err;
  }
}
