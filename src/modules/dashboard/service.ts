// Resumen y buscador del panel — docs/api.md §11.
//
// Hoy DashboardPage baja 30 días de pedidos con sus items y agrega en el
// navegador. Acá todo se calcula en SQL, en la zona horaria del negocio: un
// "hoy" que no depende del reloj de la compu del dueño.
import { withDb } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import type { BusinessScope } from "../../lib/request.js";

const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

interface Totals {
  sales_today: string;
  sales_week: string;
  sales_month: string;
  orders_today: bigint;
  orders_pending: bigint;
  average_ticket: string;
}

export async function summary({ ctx, businessId }: BusinessScope, days: number) {
  return withDb(ctx, async (tx) => {
    const business = await tx.business.findFirst({
      where: { id: businessId },
      select: { timezone: true, currency: true }
    });
    if (!business) throw notFound("No encontramos el negocio.");
    const zone = business.timezone || DEFAULT_TZ;

    // `status <> 'cancelled'`: un pedido cancelado no es venta.
    const [totals] = await tx.$queryRaw<Totals[]>`
      with o as (
        select total, status, (created_at at time zone ${zone})::date as local_date
        from public.orders where business_id = ${businessId}::uuid
      ), t as (select (now() at time zone ${zone})::date as d)
      select
        coalesce(sum(total) filter (where local_date = t.d and status <> 'cancelled'), 0) as sales_today,
        coalesce(sum(total) filter (where local_date > t.d - 7 and status <> 'cancelled'), 0) as sales_week,
        coalesce(sum(total) filter (where local_date > t.d - 30 and status <> 'cancelled'), 0) as sales_month,
        count(*) filter (where local_date = t.d) as orders_today,
        count(*) filter (where status = 'pending') as orders_pending,
        coalesce(avg(total) filter (where status <> 'cancelled' and local_date > t.d - ${days}::int), 0) as average_ticket
      from o cross join t`;

    const byStatus = await tx.order.groupBy({
      by: ["status"],
      where: { businessId },
      _count: { _all: true }
    });

    // Serie completa: los días sin ventas van en cero, para que el gráfico no
    // dibuje saltos donde no hubo pedidos.
    const salesByDay = await tx.$queryRaw<{ date: string; total: string; count: bigint }[]>`
      with t as (select (now() at time zone ${zone})::date as d)
      select to_char(g.day, 'YYYY-MM-DD') as date,
             coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0) as total,
             count(o.id) as count
      from t, generate_series(t.d - (${days}::int - 1), t.d, interval '1 day') as g(day)
      left join public.orders o
        on o.business_id = ${businessId}::uuid
       and (o.created_at at time zone ${zone})::date = g.day::date
      group by g.day
      order by g.day`;

    const topProducts = await tx.$queryRaw<
      { product_id: string | null; product_name: string; quantity: bigint; total: string }[]
    >`
      with t as (select (now() at time zone ${zone})::date as d)
      select i.product_id, i.product_name,
             sum(i.quantity)::bigint as quantity,
             sum(i.total_price) as total
      from public.order_items i
      join public.orders o on o.id = i.order_id
      cross join t
      where i.business_id = ${businessId}::uuid
        and o.status <> 'cancelled'
        and (o.created_at at time zone ${zone})::date > t.d - ${days}::int
      group by i.product_id, i.product_name
      order by quantity desc, total desc
      limit 10`;

    const [lowProducts, lowValues, lowIngredients, recentOrders, bot, conversationsCount] = await Promise.all([
      tx.$queryRaw<{ id: string; name: string; stock_quantity: number; low_stock_threshold: number }[]>`
        select id, name, stock_quantity, low_stock_threshold
        from public.products
        where business_id = ${businessId}::uuid and track_stock and stock_quantity <= low_stock_threshold
        order by stock_quantity asc limit 20`,
      tx.$queryRaw<{ id: string; name: string; stock_quantity: number; low_stock_threshold: number }[]>`
        select id, name, stock_quantity, low_stock_threshold
        from public.product_option_values
        where business_id = ${businessId}::uuid and track_stock and stock_quantity <= low_stock_threshold
        order by stock_quantity asc limit 20`,
      tx.$queryRaw<{ id: string; name: string; quantity: string; low_stock_threshold: string; unit: string }[]>`
        select id, name, quantity, low_stock_threshold, unit
        from public.inventory_ingredients
        where business_id = ${businessId}::uuid and quantity <= low_stock_threshold
        order by quantity asc limit 20`,
      tx.order.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          orderCode: true,
          status: true,
          orderType: true,
          source: true,
          customerName: true,
          total: true,
          paymentStatus: true,
          createdAt: true
        }
      }),
      tx.botSettings.findUnique({ where: { businessId }, select: { isEnabled: true } }),
      tx.whatsappConversation.count({ where: { businessId, status: { not: "closed" } } })
    ]);

    const statusCounts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));

    return {
      currency: business.currency,
      timezone: zone,
      sales: {
        today: toNumber(totals!.sales_today),
        week: toNumber(totals!.sales_week),
        month: toNumber(totals!.sales_month)
      },
      orders: {
        today: Number(totals!.orders_today),
        pending: Number(totals!.orders_pending),
        byStatus: statusCounts
      },
      averageTicket: Math.round(toNumber(totals!.average_ticket) * 100) / 100,
      salesByDay: salesByDay.map((d) => ({ date: d.date, total: toNumber(d.total), count: Number(d.count) })),
      topProducts: topProducts.map((p) => ({
        productId: p.product_id,
        name: p.product_name,
        quantity: Number(p.quantity),
        total: toNumber(p.total)
      })),
      lowStock: {
        products: lowProducts.map((p) => ({
          id: p.id,
          name: p.name,
          stockQuantity: p.stock_quantity,
          lowStockThreshold: p.low_stock_threshold
        })),
        optionValues: lowValues.map((v) => ({
          id: v.id,
          name: v.name,
          stockQuantity: v.stock_quantity,
          lowStockThreshold: v.low_stock_threshold
        })),
        ingredients: lowIngredients.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: toNumber(i.quantity),
          lowStockThreshold: toNumber(i.low_stock_threshold),
          unit: i.unit
        }))
      },
      recentOrders: recentOrders.map((o) => ({ ...o, total: toNumber(o.total) })),
      bot: { enabled: bot?.isEnabled ?? false },
      conversationsCount
    };
  });
}

interface SearchRow {
  result_id: string;
  result_group: string;
  title: string;
  detail: string | null;
  href: string;
  rank: string;
}

/** `search_dashboard` busca productos, clientes y pedidos con unaccent + trigramas. */
export async function search({ ctx, businessId }: BusinessScope, q: string) {
  const rows = await withDb(ctx, (tx) =>
    tx.$queryRaw<SearchRow[]>`select * from public.search_dashboard(${businessId}::uuid, ${q})`
  );
  return rows.map((r) => ({
    id: r.result_id,
    group: r.result_group,
    title: r.title,
    detail: r.detail,
    href: r.href,
    rank: toNumber(r.rank)
  }));
}

// ── Operación (agente v3, fase V3b) ─────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole > 0 ? round1((part / whole) * 100) : 0);

/**
 * Cancelaciones, reembolsos, derivaciones y modificaciones de los últimos
 * `days` días (en la zona del negocio). Todo en SQL sobre las columnas y
 * tablas de 0010: el panel no baja pedidos para contarlos.
 */
export async function operations({ ctx, businessId }: BusinessScope, days: number) {
  return withDb(ctx, async (tx) => {
    const business = await tx.business.findFirst({ where: { id: businessId }, select: { timezone: true } });
    if (!business) throw notFound("No encontramos el negocio.");
    const zone = business.timezone || DEFAULT_TZ;

    const [orders] = await tx.$queryRaw<
      {
        total: bigint;
        cancelled: bigint;
        cancelled_amount: string;
        by_customer: bigint;
        by_business: bigint;
        modified: bigint;
        modified_preparing: bigint;
        modifications: bigint;
      }[]
    >`
      with t as (select (now() at time zone ${zone})::date as d),
      o as (
        select o.* from public.orders o, t
        where o.business_id = ${businessId}::uuid
          and (o.created_at at time zone ${zone})::date > t.d - ${days}::int
      )
      select
        count(*) as total,
        count(*) filter (where status = 'cancelled') as cancelled,
        coalesce(sum(total) filter (where status = 'cancelled'), 0) as cancelled_amount,
        count(*) filter (where cancelled_by = 'customer_whatsapp') as by_customer,
        count(*) filter (where cancelled_by = 'business_dashboard') as by_business,
        count(*) filter (where modification_count > 0) as modified,
        count(*) filter (where last_modified_during = 'preparing') as modified_preparing,
        coalesce(sum(modification_count), 0)::bigint as modifications
      from o`;

    // En qué estado estaba el pedido cuando se canceló (historial).
    const cancelledFrom = await tx.$queryRaw<{ status: string; count: bigint }[]>`
      with t as (select (now() at time zone ${zone})::date as d)
      select coalesce(h.from_status::text, 'pending') as status, count(*) as count
      from public.order_status_history h, t
      where h.business_id = ${businessId}::uuid
        and h.to_status = 'cancelled'
        and (h.created_at at time zone ${zone})::date > t.d - ${days}::int
      group by 1 order by 2 desc`;

    const refunds = await tx.$queryRaw<{ status: string; count: bigint; amount: string; avg_hours: string | null }[]>`
      with t as (select (now() at time zone ${zone})::date as d)
      select r.status, count(*) as count, coalesce(sum(r.amount), 0) as amount,
             avg(extract(epoch from (r.completed_at - r.requested_at)) / 3600)
               filter (where r.status = 'completed') as avg_hours
      from public.order_refunds r, t
      where r.business_id = ${businessId}::uuid
        and (r.requested_at at time zone ${zone})::date > t.d - ${days}::int
      group by r.status`;

    const cases = await tx.$queryRaw<{ reason: string; open: bigint; resolved: bigint; avg_minutes: string | null }[]>`
      with t as (select (now() at time zone ${zone})::date as d)
      select c.reason,
             count(*) filter (where c.status = 'open') as open,
             count(*) filter (where c.status = 'resolved') as resolved,
             avg(extract(epoch from (c.resolved_at - c.opened_at)) / 60)
               filter (where c.status = 'resolved') as avg_minutes
      from public.conversation_cases c, t
      where c.business_id = ${businessId}::uuid
        and (c.opened_at at time zone ${zone})::date > t.d - ${days}::int
      group by c.reason
      order by count(*) desc`;

    const total = Number(orders?.total ?? 0);
    const cancelled = Number(orders?.cancelled ?? 0);
    const modified = Number(orders?.modified ?? 0);
    const refundBy = (status: string) => refunds.find((r) => r.status === status);

    return {
      days,
      orders: {
        total,
        cancelled,
        cancelRate: pct(cancelled, total),
        cancelledAmount: toNumber(orders?.cancelled_amount ?? 0),
        cancelledBy: {
          customerWhatsapp: Number(orders?.by_customer ?? 0),
          businessDashboard: Number(orders?.by_business ?? 0)
        },
        cancelledFromStatus: cancelledFrom.map((r) => ({ status: r.status, count: Number(r.count) }))
      },
      modifications: {
        orders: modified,
        rate: pct(modified, total),
        duringPreparation: Number(orders?.modified_preparing ?? 0),
        total: Number(orders?.modifications ?? 0)
      },
      refunds: {
        pending: { count: Number(refundBy("pending")?.count ?? 0), amount: toNumber(refundBy("pending")?.amount ?? 0) },
        completed: {
          count: Number(refundBy("completed")?.count ?? 0),
          amount: toNumber(refundBy("completed")?.amount ?? 0),
          avgHours: refundBy("completed")?.avg_hours ? round1(Number(refundBy("completed")!.avg_hours)) : null
        },
        rejected: { count: Number(refundBy("rejected")?.count ?? 0), amount: toNumber(refundBy("rejected")?.amount ?? 0) }
      },
      cases: cases.map((c) => ({
        reason: c.reason,
        open: Number(c.open),
        resolved: Number(c.resolved),
        avgResolutionMinutes: c.avg_minutes ? Math.round(Number(c.avg_minutes)) : null
      }))
    };
  });
}
