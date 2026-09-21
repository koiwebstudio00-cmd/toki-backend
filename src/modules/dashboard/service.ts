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
