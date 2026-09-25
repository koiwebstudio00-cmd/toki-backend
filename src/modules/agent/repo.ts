// Queries del agente v3 (contexto, carta, ids cortos, vencimiento del
// borrador). Las RPC heredadas `agent_*` siguen en service.ts.
//
// Todo corre con service_role: cada query filtra por `business_id` a mano.
import type { Tx } from "../../lib/db.js";

// ── Reloj del negocio ───────────────────────────────────────────────────────

export interface ClockRow {
  timezone: string;
  manual_status: string;
  is_open: boolean;
  now_local: string; // "YYYY-MM-DDTHH:MM" en la zona del negocio
}

export interface WindowRow {
  date: string; // "YYYY-MM-DD"
  opens: string; // "HH:MM"
  closes: string; // "HH:MM"
}

/** Hora local del negocio y si está abierto (lo decide `business_is_open`). */
export async function clock(tx: Tx, businessId: string): Promise<ClockRow | null> {
  const rows = await tx.$queryRaw<ClockRow[]>`
    select
      coalesce(nullif(b.timezone, ''), 'America/Argentina/Buenos_Aires') as timezone,
      b.manual_status,
      public.business_is_open(b.id) as is_open,
      to_char(now() at time zone coalesce(nullif(b.timezone, ''), 'America/Argentina/Buenos_Aires'),
              'YYYY-MM-DD"T"HH24:MI') as now_local
    from public.businesses b
    where b.id = ${businessId}::uuid`;
  return rows[0] ?? null;
}

/**
 * Turnos de atención desde ayer hasta dentro de 7 días, con las excepciones
 * ya aplicadas (`business_schedule_windows` reemplaza el horario semanal por
 * el especial cuando hay uno). Ayer entra por los turnos que cruzan la
 * medianoche.
 */
export function windows(tx: Tx, businessId: string, localDate: string) {
  return tx.$queryRaw<WindowRow[]>`
    select
      to_char(d::date, 'YYYY-MM-DD') as date,
      to_char(w.opens_at, 'HH24:MI') as opens,
      to_char(w.closes_at, 'HH24:MI') as closes
    from generate_series(${localDate}::date - 1, ${localDate}::date + 7, interval '1 day') as d
    cross join lateral public.business_schedule_windows(${businessId}::uuid, d::date) as w
    order by d, w.opens_at`;
}

// ── Carta ───────────────────────────────────────────────────────────────────

/** Lo mismo que muestra el menú web: disponible y con stock si lo controla. */
const availableProduct = { isAvailable: true, OR: [{ trackStock: false }, { stockQuantity: { gt: 0 } }] };

export function menuProducts(tx: Tx, businessId: string) {
  return tx.product.findMany({
    where: {
      businessId,
      ...availableProduct,
      // Un producto de una categoría desactivada no se ve en el menú web.
      AND: [{ OR: [{ categoryId: null }, { category: { isActive: true } }] }]
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      isFeatured: true,
      category: { select: { name: true, sortOrder: true } },
      options: {
        orderBy: { sortOrder: "asc" },
        select: {
          name: true,
          isRequired: true,
          minSelect: true,
          maxSelect: true,
          values: {
            where: { isAvailable: true, OR: [{ trackStock: false }, { stockQuantity: { gt: 0 } }] },
            orderBy: { sortOrder: "asc" },
            select: { id: true, name: true, priceDelta: true }
          }
        }
      }
    }
  });
}

/** Todos los ids de productos y valores del negocio: el espacio de los ids cortos. */
export async function catalogIds(tx: Tx, businessId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    select id::text as id from public.products where business_id = ${businessId}::uuid
    union all
    select id::text from public.product_option_values where business_id = ${businessId}::uuid`;
  return rows.map((r) => r.id);
}

/** Ids de productos del negocio que empiezan con `prefix` (a lo sumo 2: alcanza para saber si es ambiguo). */
export async function productIdsByPrefix(tx: Tx, businessId: string, prefix: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    select id::text as id from public.products
    where business_id = ${businessId}::uuid and id::text like ${`${prefix}%`}
    limit 2`;
  return rows.map((r) => r.id);
}

export async function optionValueIdsByPrefix(tx: Tx, businessId: string, prefix: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    select id::text as id from public.product_option_values
    where business_id = ${businessId}::uuid and id::text like ${`${prefix}%`}
    limit 2`;
  return rows.map((r) => r.id);
}

// ── Bot ─────────────────────────────────────────────────────────────────────

export function botSettings(tx: Tx, businessId: string) {
  return tx.botSettings.findUnique({
    where: { businessId },
    select: { botName: true, tone: true, handoffEnabled: true }
  });
}

// ── Borrador ────────────────────────────────────────────────────────────────

/**
 * Descarta el borrador abierto si no tuvo cambios en `hours` horas. Devuelve
 * cuántos descartó (0 o 1: hay un borrador por conversación).
 */
export function expireStaleDraft(tx: Tx, businessId: string, conversationId: string, hours: number) {
  return tx.$executeRaw`
    update public.whatsapp_order_drafts
    set status = 'cancelled'
    where business_id = ${businessId}::uuid
      and conversation_id = ${conversationId}::uuid
      and status = 'open'
      and updated_at < now() - make_interval(hours => ${hours}::int)`;
}

/** ¿La conversación es de este negocio? Las RPC lo validan; las rutas nuevas en TS, acá. */
export async function conversationBelongs(tx: Tx, businessId: string, conversationId: string): Promise<boolean> {
  return (await tx.whatsappConversation.count({ where: { id: conversationId, businessId } })) > 0;
}

/** Item de un borrador abierto de la conversación, con lo necesario para validar stock. */
export function openDraftItem(tx: Tx, businessId: string, conversationId: string, itemId: string) {
  return tx.whatsappOrderDraftItem.findFirst({
    where: { id: itemId, businessId, draft: { conversationId, businessId, status: "open" } },
    select: {
      id: true,
      unitPrice: true,
      optionValueIds: true,
      product: { select: { name: true, trackStock: true, stockQuantity: true } }
    }
  });
}

/** Valores de opción que controlan stock y no alcanzan para `quantity`. */
export function optionValuesShort(tx: Tx, businessId: string, ids: string[], quantity: number) {
  if (!ids.length) return Promise.resolve([]);
  return tx.productOptionValue.findMany({
    where: { businessId, id: { in: ids }, trackStock: true, stockQuantity: { lt: quantity } },
    select: { name: true, stockQuantity: true }
  });
}

export function updateDraftItemQuantity(tx: Tx, itemId: string, quantity: number, unitPrice: number) {
  return tx.whatsappOrderDraftItem.update({
    where: { id: itemId },
    data: { quantity, totalPrice: unitPrice * quantity }
  });
}

export function deleteDraftItem(tx: Tx, itemId: string) {
  return tx.whatsappOrderDraftItem.delete({ where: { id: itemId } });
}

/** El borrador de la conversación, como lo ve el agente (`agent_draft_json`). */
export async function draftJson(tx: Tx, conversationId: string) {
  const rows = await tx.$queryRaw<{ result: Record<string, unknown> | null }[]>`
    select public.agent_draft_json(${conversationId}::uuid) as result`;
  return rows[0]?.result ?? null;
}

/**
 * Pedido que entró con el local cerrado: se deja dicho en la primera entrada
 * del historial (la que crea `persist_order`, sin nota), así el local lo ve en
 * el detalle del pedido.
 */
export function noteClosedOrder(tx: Tx, orderId: string, note: string) {
  return tx.orderStatusHistory.updateMany({
    where: { orderId, note: null, toStatus: "pending" },
    data: { note }
  });
}

export function transferSettings(tx: Tx, businessId: string) {
  return tx.paymentSettings.findUnique({
    where: { businessId },
    select: { transferAlias: true, transferCbu: true, transferHolder: true, transferBank: true }
  });
}

// ── Pedidos hechos (v3) ─────────────────────────────────────────────────────

const ORDER_CODE = /TK-\d{6}/i;

/** Código TK-XXXXXX normalizado, o null si el texto no trae uno. */
export function normalizeOrderCode(value: string | null | undefined): string | null {
  const match = (value ?? "").match(ORDER_CODE);
  return match ? match[0].toUpperCase() : null;
}

/**
 * El pedido del que habla el cliente: el del código si lo dio (cualquier
 * estado, siempre del negocio), o el último en curso de la conversación o de
 * su teléfono (un pedido hecho en la web también cuenta).
 */
export async function resolveOrderId(
  tx: Tx,
  businessId: string,
  conversationId: string,
  orderCode?: string | null
): Promise<string | null> {
  const code = normalizeOrderCode(orderCode);
  if (code) {
    const order = await tx.order.findFirst({ where: { businessId, orderCode: code }, select: { id: true } });
    return order?.id ?? null;
  }
  const conversation = await tx.whatsappConversation.findFirst({
    where: { id: conversationId, businessId },
    select: { phone: true }
  });
  const order = await tx.order.findFirst({
    where: {
      businessId,
      status: { notIn: ["delivered", "cancelled"] },
      OR: [
        { whatsappConversationId: conversationId },
        ...(conversation?.phone ? [{ customerPhone: conversation.phone }] : [])
      ]
    },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  return order?.id ?? null;
}

/** Bloquea el pedido hasta el fin de la transacción: dos cambios a la vez no se pisan. */
export async function lockOrder(tx: Tx, orderId: string): Promise<void> {
  await tx.$queryRaw`select id from public.orders where id = ${orderId}::uuid for update`;
}

export function orderForChange(tx: Tx, orderId: string) {
  return tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: { orderBy: { createdAt: "asc" }, include: { options: true } },
      coupon: true,
      business: { select: { deliveryFee: true, minimumOrderAmount: true } }
    }
  });
}

export async function orderJson(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<{ result: Record<string, unknown> | null }[]>`
    select public.agent_order_json(${orderId}::uuid) as result`;
  return rows[0]?.result ?? null;
}

/** Devuelve stock: el pedido entero (`items` null) o parte ([{ orderItemId, quantity }]). */
export async function restock(tx: Tx, orderId: string, items: { orderItemId: string; quantity: number }[] | null) {
  await tx.$executeRaw`select public.restock_order_items(${orderId}::uuid, ${items ? JSON.stringify(items) : null}::jsonb)`;
}

/** Descuenta stock como persist_order: solo donde se controla, y pausa lo que llega a 0. */
export async function deductStock(
  tx: Tx,
  businessId: string,
  entries: { productId: string | null; optionValueIds: string[]; quantity: number }[]
) {
  for (const entry of entries) {
    if (entry.productId) {
      await tx.$executeRaw`
        update public.products
        set stock_quantity = greatest(0, stock_quantity - ${entry.quantity}::int),
            is_available = case when stock_quantity - ${entry.quantity}::int <= 0 then false else is_available end,
            updated_at = now()
        where id = ${entry.productId}::uuid and business_id = ${businessId}::uuid and track_stock`;
    }
    for (const valueId of entry.optionValueIds) {
      await tx.$executeRaw`
        update public.product_option_values
        set stock_quantity = greatest(0, stock_quantity - ${entry.quantity}::int),
            is_available = case when stock_quantity - ${entry.quantity}::int <= 0 then false else is_available end,
            updated_at = now()
        where id = ${valueId}::uuid and business_id = ${businessId}::uuid and track_stock`;
    }
  }
}

/** Stock disponible de un producto y sus valores, para subir una cantidad. */
export function stockFor(tx: Tx, businessId: string, productId: string | null, valueIds: string[]) {
  return Promise.all([
    productId
      ? tx.product.findFirst({
          where: { id: productId, businessId },
          select: { name: true, trackStock: true, stockQuantity: true }
        })
      : Promise.resolve(null),
    valueIds.length
      ? tx.productOptionValue.findMany({
          where: { id: { in: valueIds }, businessId },
          select: { name: true, trackStock: true, stockQuantity: true }
        })
      : Promise.resolve([])
  ]);
}

export function paymentSettings(tx: Tx, businessId: string) {
  return tx.paymentSettings.findUnique({ where: { businessId } });
}

export async function paidAmount(tx: Tx, orderId: string): Promise<number> {
  const agg = await tx.payment.aggregate({ where: { orderId, status: "paid" }, _sum: { amount: true } });
  return Number(agg._sum.amount ?? 0);
}

/** Último reembolso pendiente de la conversación (o de un pedido puntual). */
export function pendingRefund(tx: Tx, businessId: string, conversationId: string, orderId: string | null) {
  return tx.orderRefund.findFirst({
    where: {
      businessId,
      status: "pending",
      ...(orderId ? { orderId } : { OR: [{ conversationId }, { order: { whatsappConversationId: conversationId } }] })
    },
    orderBy: { requestedAt: "desc" }
  });
}

/** Último adjunto (imagen o PDF) que mandó el cliente, para el comprobante mandado en ráfaga. */
export function latestInboundMedia(tx: Tx, businessId: string, conversationId: string, since: Date) {
  return tx.whatsappMessage.findFirst({
    where: {
      businessId,
      conversationId,
      direction: "inbound",
      messageType: { in: ["image", "document"] },
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" },
    select: { rawPayload: true, providerMessageId: true, messageType: true }
  });
}
