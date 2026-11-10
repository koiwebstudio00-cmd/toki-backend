import { systemCtx, withDb } from "../../lib/db.js";
import { toNumber } from "../../lib/money.js";

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
  const since = new Date(Date.now() - days * 86_400_000);
  return withDb(systemCtx, async tx => {
    const users = await tx.user.count();
    const newUsers = await tx.user.count({ where: { createdAt: { gte: since } } });
    const businesses = await tx.business.count();
    const activeBusinesses = await tx.business.count({ where: { isActive: true } });
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
    return { days, users, newUsers, businesses, activeBusinesses, orders, statuses, sources };
  });
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

export async function listBusinesses(cursor?: string, query?: string) {
  return withDb(systemCtx, async tx => page((await tx.business.findMany({
    ...pagination(cursor),
    ...(query ? { where: { OR: [
      { name: { contains: query, mode: "insensitive" as const } },
      { slug: { contains: query, mode: "insensitive" as const } }
    ] } } : {}),
    select: { id: true, name: true, slug: true, city: true, isActive: true, createdAt: true,
      _count: { select: { orders: true, businessMembers: true } } }
  })).map(({ _count, ...row }) => ({ ...row, orders: _count.orders, users: _count.businessMembers }))));
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
