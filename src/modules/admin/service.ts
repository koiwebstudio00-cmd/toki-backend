import type { Prisma } from "@prisma/client";
import { systemCtx, withDb } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import * as detail from "./detail.repo.js";
import { maskPhone, whatsappStatus } from "./mapping.js";
import * as stats from "./stats.repo.js";

const pageSize = 25;
const newestFirst = [{ createdAt: "desc" }, { id: "desc" }] as const;

function pagination(cursor?: string) {
  return { orderBy: [...newestFirst], take: pageSize + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
}

function page<T extends { id: string }>(rows: T[]) {
  const data = rows.slice(0, pageSize);
  return { data, nextCursor: rows.length > pageSize ? data.at(-1)!.id : null };
}

export async function overview(days: 7 | 30 | 90) {
  return withDb(systemCtx, async tx => {
    // Ventana de días calendario (hora de Argentina) y el período anterior de igual duración.
    const { since, previousSince } = await stats.periodBounds(tx, days);
    const users = await tx.user.count();
    const newUsers = await tx.user.count({ where: { createdAt: { gte: since } } });
    const businesses = await tx.business.count();
    const activeBusinesses = await tx.business.count({ where: { isActive: true } });
    const newBusinesses = await tx.business.count({ where: { createdAt: { gte: since } } });
    const groups = await tx.order.groupBy({
      by: ["status", "source"], where: { createdAt: { gte: since } }, _count: { _all: true }
    });
    const statuses: Record<string, number> = {};
    const sources: Record<string, number> = {};
    let orders = 0;
    for (const group of groups) {
      const count = group._count._all;
      statuses[group.status] = (statuses[group.status] ?? 0) + count;
      sources[group.source] = (sources[group.source] ?? 0) + count;
      orders += count;
    }

    const current = await stats.revenueByCurrency(tx, since);
    const before = await stats.revenueByCurrency(tx, previousSince, since);
    const revenue = current.map(row => ({ ...row, averageTicket: row.orders ? Math.round(row.total / row.orders * 100) / 100 : 0,
      previousTotal: before.find(item => item.currency === row.currency)?.total ?? 0 }));
    for (const row of before) {
      if (!revenue.some(item => item.currency === row.currency)) revenue.push({ currency: row.currency, orders: 0, total: 0, averageTicket: 0, previousTotal: row.total });
    }
    const previous = await stats.countsBetween(tx, previousSince, since);

    const series = calendarDays(since, days).map(date => ({ date, orders: 0, users: 0, businesses: 0, revenue: {} as Record<string, number> }));
    const byDate = new Map(series.map(point => [point.date, point]));
    for (const row of await stats.dailyOrders(tx, since)) {
      const point = byDate.get(row.date);
      if (!point) continue;
      point.orders += row.orders;
      point.revenue[row.currency] = (point.revenue[row.currency] ?? 0) + row.revenue;
    }
    for (const row of await stats.dailySignups(tx, since)) {
      const point = byDate.get(row.date);
      if (point) { point.users = row.users; point.businesses = row.businesses; }
    }

    return {
      days, since: since.toISOString(), users, newUsers, businesses, activeBusinesses, newBusinesses, orders, statuses, sources,
      revenue, previous, series,
      topBusinesses: await stats.topBusinesses(tx, since),
      businessActivity: await stats.businessActivity(tx, since),
      dormantBusinesses: await stats.dormantBusinesses(tx, since),
      invitations: await stats.invitationFunnel(tx, since)
    };
  });
}

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: stats.ADMIN_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
/** Fechas YYYY-MM-DD desde `since` (medianoche en Argentina), una por día. */
function calendarDays(since: Date, days: number) {
  // Mediodía de cada día: inmune a cambios de horario si la zona los vuelve a tener.
  return Array.from({ length: days }, (_, index) => dayKey.format(new Date(since.getTime() + (index + 0.5) * 86_400_000)));
}

export async function listUsers(cursor?: string, query?: string) {
  return withDb(systemCtx, async tx => page((await tx.user.findMany({
    ...pagination(cursor),
    ...(query ? { where: { email: { contains: query, mode: "insensitive" } } } : {}),
    select: { id: true, email: true, createdAt: true, emailVerifiedAt: true,
      profile: { select: { fullName: true } }, _count: { select: { members: true } } }
  })).map(({ profile, _count, ...row }) => ({
    ...row, fullName: profile?.fullName ?? null, businesses: _count.members
  }))));
}

export type WhatsappFilter = "connected" | "pending" | "none";

const whatsappFilter: Record<WhatsappFilter, Prisma.BusinessWhereInput> = {
  connected: { whatsappIntegration: { isActive: true } },
  pending: { whatsappIntegration: { isActive: false } },
  none: { whatsappIntegration: { is: null } },
};

export async function listBusinesses(cursor?: string, query?: string, whatsapp?: WhatsappFilter) {
  const filters: Prisma.BusinessWhereInput[] = [];
  if (query) filters.push({ OR: [
    { name: { contains: query, mode: "insensitive" as const } },
    { slug: { contains: query, mode: "insensitive" as const } },
  ] });
  if (whatsapp) filters.push(whatsappFilter[whatsapp]);
  return withDb(systemCtx, async tx => page((await tx.business.findMany({
    ...pagination(cursor),
    ...(filters.length ? { where: { AND: filters } } : {}),
    select: { id: true, name: true, slug: true, city: true, isActive: true, createdAt: true,
      _count: { select: { orders: true, businessMembers: true } },
      whatsappIntegration: { select: { provider: true, isActive: true, phoneNumber: true } } }
  })).map(({ _count, whatsappIntegration, ...row }) => ({
    ...row, orders: _count.orders, users: _count.businessMembers, whatsapp: whatsappStatus(whatsappIntegration),
  }))));
}

const DAY_MS = 86_400_000;

/** Detalle de un negocio: equipo, actividad de 30 días, estado de WhatsApp y últimos pedidos. */
export async function businessDetail(id: string) {
  return withDb(systemCtx, async tx => {
    const business = await detail.businessBase(tx, id);
    if (!business) throw notFound("El negocio no existe.");
    const period = await detail.businessPeriod(tx, id, new Date(Date.now() - 30 * DAY_MS));
    const last = await detail.lastOrderAt(tx, id);
    const orders = await detail.recentOrders(tx, id, 5);
    const integration = await detail.whatsappIntegrationOf(tx, id);
    const lastMessageAt = await detail.lastWhatsappMessageAt(tx, id);
    const conversationsLast7d = await detail.conversationsSince(tx, id, new Date(Date.now() - 7 * DAY_MS));
    return {
      id: business.id, name: business.name, slug: business.slug, city: business.city, currency: business.currency,
      isActive: business.isActive, createdAt: business.createdAt,
      members: business.businessMembers.map(member => ({
        userId: member.user.id, email: member.user.email, fullName: member.user.profile?.fullName ?? null, role: member.role,
      })),
      stats: { orders30d: period._count._all, revenue30d: toNumber(period._sum.total) ?? 0, lastOrderAt: last?.createdAt ?? null },
      whatsapp: { ...whatsappStatus(integration), lastMessageAt, conversationsLast7d },
      recentOrders: orders.map(order => ({ ...order, total: toNumber(order.total) })),
    };
  });
}

/** Detalle de una cuenta: sin campos de administración ni sesiones. */
export async function userDetail(id: string) {
  return withDb(systemCtx, async tx => {
    const user = await detail.userBase(tx, id);
    if (!user) throw notFound("El usuario no existe.");
    return {
      id: user.id, email: user.email, fullName: user.profile?.fullName ?? null,
      createdAt: user.createdAt, emailVerifiedAt: user.emailVerifiedAt,
      businesses: user.members.map(member => ({ id: member.business.id, name: member.business.name, role: member.role })),
    };
  });
}

/** Detalle de un pedido. El teléfono del cliente sale enmascarado y la dirección no sale (D3). */
export async function orderDetail(id: string) {
  return withDb(systemCtx, async tx => {
    const order = await detail.orderBase(tx, id);
    if (!order) throw notFound("El pedido no existe.");
    return {
      id: order.id, orderCode: order.orderCode, status: order.status, paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod, orderType: order.orderType, source: order.source, createdAt: order.createdAt,
      business: order.business,
      customer: { name: order.customerName, phone: maskPhone(order.customerPhone) },
      amounts: {
        subtotal: toNumber(order.subtotal), deliveryFee: toNumber(order.deliveryFee),
        discountTotal: toNumber(order.discountTotal), total: toNumber(order.total),
      },
      items: order.items.map(item => ({
        productName: item.productName, quantity: toNumber(item.quantity), unitPrice: toNumber(item.unitPrice),
        totalPrice: toNumber(item.totalPrice), options: item.options.map(option => ({ name: option.optionName, value: option.valueName })),
      })),
      history: order.statusHistory.map(entry => ({ from: entry.fromStatus, to: entry.toStatus, at: entry.createdAt, note: entry.note })),
      paymentProofs: order.paymentProofs,
    };
  });
}

export async function listOrders(cursor?: string, query?: string) {
  return withDb(systemCtx, async tx => page((await tx.order.findMany({
    ...pagination(cursor),
    ...(query ? { where: { OR: [
      { orderCode: { contains: query, mode: "insensitive" as const } },
      { business: { name: { contains: query, mode: "insensitive" as const } } }
    ] } } : {}),
    select: { id: true, orderCode: true, createdAt: true, status: true, paymentStatus: true, source: true,
      total: true, business: { select: { name: true, currency: true } } }
  })).map(({ total, ...row }) => ({ ...row, total: toNumber(total) }))));
}
