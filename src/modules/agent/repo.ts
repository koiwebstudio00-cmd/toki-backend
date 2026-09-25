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
