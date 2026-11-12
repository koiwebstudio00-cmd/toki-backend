import type { Tx } from "../../lib/db.js";

// Consultas de lectura del detalle de negocios, usuarios y pedidos del panel de admin.
// Corren con systemCtx: cada función selecciona solo los campos que el panel muestra.

export const businessBase = (tx: Tx, id: string) => tx.business.findUnique({
  where: { id },
  select: {
    id: true, name: true, slug: true, city: true, currency: true, isActive: true, createdAt: true,
    businessMembers: { orderBy: { createdAt: "asc" }, select: { role: true,
      user: { select: { id: true, email: true, profile: { select: { fullName: true } } } } } },
  },
});

export const businessPeriod = (tx: Tx, businessId: string, since: Date) => tx.order.aggregate({
  where: { businessId, createdAt: { gte: since }, status: { not: "cancelled" } },
  _count: { _all: true },
  _sum: { total: true },
});

export const lastOrderAt = (tx: Tx, businessId: string) => tx.order.findFirst({
  where: { businessId }, orderBy: { createdAt: "desc" }, select: { createdAt: true },
});

export const recentOrders = (tx: Tx, businessId: string, take: number) => tx.order.findMany({
  where: { businessId }, take, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  select: { id: true, orderCode: true, status: true, paymentStatus: true, source: true, total: true, createdAt: true },
});

export const whatsappIntegrationOf = (tx: Tx, businessId: string) => tx.whatsappIntegration.findUnique({
  where: { businessId }, select: { provider: true, isActive: true, phoneNumber: true },
});

export const lastWhatsappMessageAt = async (tx: Tx, businessId: string) => {
  const row = await tx.whatsappMessage.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return row?.createdAt ?? null;
};

export const conversationsSince = (tx: Tx, businessId: string, since: Date) => tx.whatsappConversation.count({
  where: { businessId, lastMessageAt: { gte: since } },
});

export const userBase = (tx: Tx, id: string) => tx.user.findUnique({
  where: { id },
  select: {
    id: true, email: true, createdAt: true, emailVerifiedAt: true,
    profile: { select: { fullName: true } },
    members: { orderBy: { createdAt: "asc" }, select: { role: true, business: { select: { id: true, name: true } } } },
  },
});

export const orderBase = (tx: Tx, id: string) => tx.order.findUnique({
  where: { id },
  select: {
    id: true, orderCode: true, status: true, paymentStatus: true, paymentMethod: true, orderType: true, source: true,
    subtotal: true, deliveryFee: true, discountTotal: true, total: true, customerName: true, customerPhone: true, createdAt: true,
    business: { select: { id: true, name: true, currency: true } },
    items: { orderBy: { createdAt: "asc" }, select: { productName: true, quantity: true, unitPrice: true, totalPrice: true,
      options: { select: { optionName: true, valueName: true } } } },
    statusHistory: { orderBy: { createdAt: "asc" }, select: { fromStatus: true, toStatus: true, createdAt: true, note: true } },
    paymentProofs: { orderBy: { createdAt: "desc" }, select: { id: true, status: true, mediaType: true, createdAt: true, reviewedAt: true } },
  },
});
