// Clientes del negocio — docs/api.md §10.
//
// Hoy CustomersPage baja todos los pedidos y agrega en el navegador. Acá los
// agregados (cantidad de pedidos, gastado, último pedido) salen de SQL.
import type { Prisma } from "@prisma/client";
import { withDb } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import type { BusinessScope } from "../../lib/request.js";
import type { ListCustomersQuery } from "./schemas.js";

interface CustomerAggregate {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  created_at: Date;
  loyalty_points: number;
  total_spent: string;
  orders_count: bigint;
  orders_total: string | null;
  last_order_at: Date | null;
  last_address: string | null;
}

export async function list({ ctx, businessId }: BusinessScope, q: ListCustomersQuery) {
  const term = q.search ? `%${q.search}%` : null;
  const offset = (q.page - 1) * q.limit;

  return withDb(ctx, async (tx) => {
    // Un solo viaje: los agregados se calculan con un lateral por cliente, que
    // usa el índice (business_id, created_at) de orders.
    const rows = await tx.$queryRaw<CustomerAggregate[]>`
      select c.id, c.name, c.phone, c.email, c.created_at, c.loyalty_points, c.total_spent,
             agg.orders_count, agg.orders_total, agg.last_order_at, addr.street as last_address
      from public.customers c
      left join lateral (
        select count(*) as orders_count, sum(o.total) as orders_total, max(o.created_at) as last_order_at
        from public.orders o
        where o.customer_id = c.id and o.business_id = c.business_id and o.status <> 'cancelled'
      ) agg on true
      -- La última dirección que usó: es lo que el panel muestra como "dirección principal".
      left join lateral (
        select a.street from public.customer_addresses a
        where a.customer_id = c.id and a.business_id = c.business_id
        order by a.created_at desc limit 1
      ) addr on true
      where c.business_id = ${businessId}::uuid
        and (${term}::text is null or c.name ilike ${term} or c.phone ilike ${term} or c.email ilike ${term})
      order by agg.last_order_at desc nulls last, c.created_at desc
      limit ${q.limit} offset ${offset}`;

    const counted = await tx.customer.count({
      where: {
        businessId,
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: "insensitive" } },
                { phone: { contains: q.search, mode: "insensitive" } },
                { email: { contains: q.search, mode: "insensitive" } }
              ]
            }
          : {})
      }
    });

    return {
      data: rows.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        createdAt: c.created_at,
        loyaltyPoints: c.loyalty_points,
        // `total_spent` lo mantiene persist_order; `ordersTotal` es lo que suman
        // los pedidos vigentes. Se muestran los dos: no siempre coinciden
        // (pedidos cancelados, ventas de mostrador anteriores al cliente).
        totalSpent: toNumber(c.total_spent),
        ordersCount: Number(c.orders_count),
        ordersTotal: toNumber(c.orders_total ?? 0),
        lastOrderAt: c.last_order_at,
        lastAddress: c.last_address
      })),
      meta: { page: q.page, limit: q.limit, total: counted, pages: Math.max(1, Math.ceil(counted / q.limit)) }
    };
  });
}

const detailInclude = {
  addresses: { orderBy: { createdAt: "asc" } },
  orders: {
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      orderCode: true,
      status: true,
      orderType: true,
      source: true,
      total: true,
      paymentStatus: true,
      createdAt: true
    }
  }
} satisfies Prisma.CustomerInclude;

export async function get({ ctx, businessId }: BusinessScope, id: string) {
  const c = await withDb(ctx, (tx) => tx.customer.findFirst({ where: { id, businessId }, include: detailInclude }));
  if (!c) throw notFound("El cliente no existe.");
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    createdAt: c.createdAt,
    loyaltyPoints: c.loyaltyPoints,
    totalSpent: toNumber(c.totalSpent),
    addresses: c.addresses.map((a) => ({
      id: a.id,
      label: a.label,
      street: a.street,
      details: a.details,
      city: a.city
    })),
    orders: c.orders.map((o) => ({ ...o, total: toNumber(o.total) }))
  };
}
