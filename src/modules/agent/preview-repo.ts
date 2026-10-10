import type { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/db.js";
import { dateFromString, dateToString, timeToString } from "../../lib/time.js";

export async function previewSchedule(tx: Tx, businessId: string, localDate: string) {
  const from = dateFromString(localDate);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 15);
  const hours = await tx.businessHour.findMany({ where: { businessId }, orderBy: { dayOfWeek: "asc" } });
  const special = await tx.businessSpecialHour.findMany({ where: { businessId, date: { gte: from, lte: to } }, orderBy: { date: "asc" } });
  return {
    dayOfWeekConvention: "0=domingo, 1=lunes, 2=martes, 3=miércoles, 4=jueves, 5=viernes, 6=sábado",
    exceptionsThrough: dateToString(to),
    weekly: hours.map((h) => ({ dayOfWeek: h.dayOfWeek, isOpen: h.isOpen, opensAt: timeToString(h.opensAt), closesAt: timeToString(h.closesAt), opensAt2: timeToString(h.opensAt2), closesAt2: timeToString(h.closesAt2) })),
    exceptions: special.map((h) => ({ date: dateToString(h.date), isClosed: h.isClosed, opensAt: timeToString(h.opensAt), closesAt: timeToString(h.closesAt), note: h.note }))
  };
}

export function previewBusiness(tx: Tx, businessId: string) {
  return tx.business.findFirst({ where: { id: businessId, isActive: true }, select: {
    name: true, description: true, address: true, city: true, phone: true, currency: true,
    minimumOrderAmount: true, deliveryFee: true, estimatedDeliveryMinutes: true
  } });
}

function visibleProducts(businessId: string): Prisma.ProductWhereInput {
  return { businessId, isAvailable: true, OR: [{ trackStock: false }, { stockQuantity: { gt: 0 } }],
    AND: [{ OR: [{ categoryId: null }, { category: { businessId, isActive: true } }] }] };
}
const productSelect = { id: true, name: true, description: true, price: true, trackStock: true, stockQuantity: true } as const;

export function previewProducts(tx: Tx, businessId: string, query: string) {
  return tx.product.findMany({ where: { AND: [visibleProducts(businessId), {
    OR: [{ name: { contains: query, mode: "insensitive" } }, { description: { contains: query, mode: "insensitive" } },
      { category: { name: { contains: query, mode: "insensitive" } } }]
  }] }, select: productSelect, take: 11, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
}

export function previewProduct(tx: Tx, businessId: string, id: string) {
  return tx.product.findFirst({ where: { ...visibleProducts(businessId), id }, select: {
    ...productSelect, options: { where: { businessId }, take: 21, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: {
      id: true, name: true, isRequired: true, minSelect: true, maxSelect: true,
      values: { where: { businessId, isAvailable: true, OR: [{ trackStock: false }, { stockQuantity: { gt: 0 } }] },
        take: 21, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, name: true, priceDelta: true } }
    } }
  } });
}

export function previewFaqs(tx: Tx, businessId: string, query: string) {
  return tx.botFaq.findMany({ where: { businessId, isActive: true,
    OR: [{ question: { contains: query, mode: "insensitive" } }, { answer: { contains: query, mode: "insensitive" } }]
  }, select: { question: true, answer: true }, take: 11, orderBy: { id: "asc" } });
}
