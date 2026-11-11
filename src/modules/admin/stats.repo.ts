import { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/db.js";
import { toNumber } from "../../lib/money.js";

// Estadísticas globales de Toki Admin (contexto de sistema). Los días se cuentan
// en hora de Argentina para que el gráfico coincida con el día calendario.
export const ADMIN_TZ = "America/Argentina/Buenos_Aires";
// Facturación: pedidos no cancelados ni reintegrados.
const sold = Prisma.sql`o.status <> 'cancelled' and o.payment_status <> 'refunded'`;

export async function periodBounds(tx: Tx, days: number) {
  const [row] = await tx.$queryRaw<{ since: Date; previousSince: Date }[]>`
    select ((now() at time zone ${ADMIN_TZ})::date - ${days - 1}::int)::timestamp at time zone ${ADMIN_TZ} as since,
           ((now() at time zone ${ADMIN_TZ})::date - ${2 * days - 1}::int)::timestamp at time zone ${ADMIN_TZ} as "previousSince"`;
  return row!;
}

export async function revenueByCurrency(tx: Tx, from: Date, to?: Date) {
  const rows = await tx.$queryRaw<{ currency: string; orders: number; total: Prisma.Decimal }[]>`
    select b.currency, count(*)::int as orders, coalesce(sum(o.total), 0)::numeric as total
    from public.orders o join public.businesses b on b.id = o.business_id
    where o.created_at >= ${from} and (${to ?? null}::timestamptz is null or o.created_at < ${to ?? null}::timestamptz) and ${sold}
    group by b.currency order by total desc`;
  return rows.map(row => ({ currency: row.currency, orders: row.orders, total: toNumber(row.total) }));
}

export async function countsBetween(tx: Tx, from: Date, to: Date) {
  const [row] = await tx.$queryRaw<{ orders: number; newUsers: number; newBusinesses: number }[]>`
    select (select count(*)::int from public.orders where created_at >= ${from} and created_at < ${to}) as orders,
           (select count(*)::int from auth.users where created_at >= ${from} and created_at < ${to}) as "newUsers",
           (select count(*)::int from public.businesses where created_at >= ${from} and created_at < ${to}) as "newBusinesses"`;
  return row!;
}

export async function dailyOrders(tx: Tx, from: Date) {
  const rows = await tx.$queryRaw<{ date: string; currency: string; orders: number; revenue: Prisma.Decimal }[]>`
    select to_char((o.created_at at time zone ${ADMIN_TZ})::date, 'YYYY-MM-DD') as date, b.currency,
           count(*)::int as orders, coalesce(sum(o.total) filter (where ${sold}), 0)::numeric as revenue
    from public.orders o join public.businesses b on b.id = o.business_id
    where o.created_at >= ${from} group by 1, 2`;
  return rows.map(row => ({ ...row, revenue: toNumber(row.revenue) }));
}

export async function dailySignups(tx: Tx, from: Date) {
  return tx.$queryRaw<{ date: string; users: number; businesses: number }[]>`
    with u as (select to_char((created_at at time zone ${ADMIN_TZ})::date, 'YYYY-MM-DD') as date, count(*)::int as n
               from auth.users where created_at >= ${from} group by 1),
         b as (select to_char((created_at at time zone ${ADMIN_TZ})::date, 'YYYY-MM-DD') as date, count(*)::int as n
               from public.businesses where created_at >= ${from} group by 1)
    select coalesce(u.date, b.date) as date, coalesce(u.n, 0) as users, coalesce(b.n, 0) as businesses
    from u full join b on b.date = u.date`;
}

export async function topBusinesses(tx: Tx, from: Date, limit = 10) {
  const rows = await tx.$queryRaw<{ id: string; name: string; slug: string; currency: string; isActive: boolean;
    orders: number; revenue: Prisma.Decimal; lastOrderAt: Date }[]>`
    select b.id, b.name, b.slug, b.currency, b.is_active as "isActive", count(o.id)::int as orders,
           coalesce(sum(o.total) filter (where ${sold}), 0)::numeric as revenue, max(o.created_at) as "lastOrderAt"
    from public.businesses b join public.orders o on o.business_id = b.id and o.created_at >= ${from}
    group by b.id order by revenue desc, orders desc, b.name limit ${limit}`;
  return rows.map(row => ({ ...row, revenue: toNumber(row.revenue) }));
}

export async function businessActivity(tx: Tx, from: Date) {
  const [row] = await tx.$queryRaw<{ withOrders: number; withoutOrders: number }[]>`
    select count(*) filter (where exists (select 1 from public.orders o where o.business_id = b.id and o.created_at >= ${from}))::int as "withOrders",
           count(*) filter (where not exists (select 1 from public.orders o where o.business_id = b.id and o.created_at >= ${from}))::int as "withoutOrders"
    from public.businesses b where b.is_active`;
  return row!;
}

/** Negocios activos sin pedidos en el período: primero los que vendían y dejaron de hacerlo. */
export async function dormantBusinesses(tx: Tx, from: Date, limit = 5) {
  return tx.$queryRaw<{ id: string; name: string; slug: string; createdAt: Date; lastOrderAt: Date | null }[]>`
    select b.id, b.name, b.slug, b.created_at as "createdAt",
           (select max(o.created_at) from public.orders o where o.business_id = b.id) as "lastOrderAt"
    from public.businesses b
    where b.is_active and not exists (select 1 from public.orders o where o.business_id = b.id and o.created_at >= ${from})
    order by "lastOrderAt" desc nulls last, b.created_at desc limit ${limit}`;
}

/** Embudo de las invitaciones creadas en el período: enviada → cuenta creada → email verificado → negocio. */
export async function invitationFunnel(tx: Tx, from: Date) {
  const [row] = await tx.$queryRaw<{ created: number; used: number; verified: number; withBusiness: number;
    pending: number; expired: number; revoked: number }[]>`
    select count(*)::int as created,
           count(*) filter (where i.used_at is not null)::int as used,
           count(*) filter (where i.used_at is not null and u.email_verified_at is not null)::int as verified,
           count(*) filter (where i.used_at is not null and exists (
             select 1 from public.business_members m where m.user_id = u.id))::int as "withBusiness",
           count(*) filter (where i.used_at is null and i.revoked_at is null and i.expires_at > now())::int as pending,
           count(*) filter (where i.used_at is null and i.revoked_at is null and i.expires_at <= now())::int as expired,
           count(*) filter (where i.used_at is null and i.revoked_at is not null)::int as revoked
    from auth.signup_invitations i left join auth.users u on u.email = i.email
    where i.created_at >= ${from}`;
  return row!;
}
