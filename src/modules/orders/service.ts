// Tablero de pedidos, estados, cobro, venta presencial y comprobantes.
// docs/api.md §9.
import type { Prisma } from "@prisma/client";
import { type Tx, withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import { presignGet } from "../../lib/r2.js";
import type { BusinessScope } from "../../lib/request.js";
import type { ChangeStatusInput, ListOrdersQuery, ManualSaleInput } from "./schemas.js";

const orderInclude = {
  items: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      options: { orderBy: { createdAt: "asc" } },
      product: { select: { id: true, barcode: true, imageUrl: true } }
    }
  },
  statusHistory: { orderBy: { createdAt: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
  customer: { select: { id: true, name: true, phone: true, loyaltyPoints: true } }
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export function toOrderDto(o: OrderRow) {
  return {
    id: o.id,
    orderCode: o.orderCode,
    status: o.status,
    orderType: o.orderType,
    source: o.source as "web" | "whatsapp" | "manual",
    customerId: o.customerId,
    customer: o.customer,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    deliveryAddress: o.deliveryAddress,
    deliveryNotes: o.deliveryNotes,
    notes: o.notes,
    subtotal: toNumber(o.subtotal),
    deliveryFee: toNumber(o.deliveryFee),
    discountTotal: toNumber(o.discountTotal),
    total: toNumber(o.total),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    couponCode: o.couponCode,
    loyaltyPointsEarned: o.loyaltyPointsEarned,
    loyaltyPointsRedeemed: o.loyaltyPointsRedeemed,
    whatsappConversationId: o.whatsappConversationId,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    items: o.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productName: i.productName,
      // El producto puede haberse borrado: el pedido conserva el nombre.
      barcode: i.product?.barcode ?? null,
      imageUrl: i.product?.imageUrl ?? null,
      quantity: i.quantity,
      unitPrice: toNumber(i.unitPrice),
      totalPrice: toNumber(i.totalPrice),
      notes: i.notes,
      options: i.options.map((op) => ({
        id: op.id,
        optionName: op.optionName,
        valueName: op.valueName,
        priceDelta: toNumber(op.priceDelta)
      }))
    })),
    statusHistory: o.statusHistory.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      note: h.note,
      createdAt: h.createdAt
    })),
    payments: o.payments.map((p) => ({
      id: p.id,
      provider: p.provider,
      status: p.status,
      amount: toNumber(p.amount),
      createdAt: p.createdAt
    }))
  };
}

/** Fin del día en UTC: el filtro `to` incluye los pedidos de esa fecha. */
function endOfDay(date: string): Date {
  return new Date(`${date}T23:59:59.999Z`);
}

export async function list({ ctx, businessId }: BusinessScope, q: ListOrdersQuery) {
  const where: Prisma.OrderWhereInput = {
    businessId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
            ...(q.to ? { lte: endOfDay(q.to) } : {})
          }
        }
      : {}),
    ...(q.search
      ? {
          OR: [
            { orderCode: { contains: q.search, mode: "insensitive" } },
            { customerName: { contains: q.search, mode: "insensitive" } },
            { customerPhone: { contains: q.search, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [rows, total] = await withDb(ctx, async (tx) => [
    await tx.order.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit
    }),
    await tx.order.count({ where })
  ]);

  return {
    data: rows.map(toOrderDto),
    meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) }
  };
}

export async function get({ ctx, businessId }: BusinessScope, id: string) {
  const row = await withDb(ctx, (tx) => tx.order.findFirst({ where: { id, businessId }, include: orderInclude }));
  if (!row) throw notFound("El pedido no existe.");
  return toOrderDto(row);
}

async function reload(tx: Tx, businessId: string, id: string) {
  const row = await tx.order.findFirst({ where: { id, businessId }, include: orderInclude });
  if (!row) throw notFound("El pedido no existe.");
  return toOrderDto(row);
}

/** `update_order_status` valida membresía y escribe el historial. */
export async function changeStatus({ ctx, businessId }: BusinessScope, id: string, input: ChangeStatusInput) {
  return withDb(ctx, async (tx) => {
    const exists = await tx.order.count({ where: { id, businessId } });
    if (exists === 0) throw notFound("El pedido no existe.");
    await tx.$executeRaw`select public.update_order_status(${id}::uuid, ${input.status}::public.order_status, ${input.note ?? null})`;
    return reload(tx, businessId, id);
  });
}

export async function markPaid({ ctx, businessId }: BusinessScope, id: string) {
  return withDb(ctx, async (tx) => {
    const exists = await tx.order.count({ where: { id, businessId } });
    if (exists === 0) throw notFound("El pedido no existe.");
    await tx.$executeRaw`select public.mark_order_paid(${id}::uuid)`;
    return reload(tx, businessId, id);
  });
}

/**
 * Venta presencial (POS). La función SQL confía en el `priceDelta` que recibe,
 * así que acá se resuelven nombres y recargos contra la base: el mostrador
 * manda ids, nunca precios (regla 10).
 */
export async function createManualSale({ ctx, businessId }: BusinessScope, input: ManualSaleInput) {
  return withDb(ctx, async (tx) => {
    const valueIds = [...new Set(input.items.flatMap((i) => i.options.flatMap((o) => o.valueIds)))];
    const values = valueIds.length
      ? await tx.productOptionValue.findMany({
          where: { id: { in: valueIds }, businessId },
          select: {
            id: true,
            name: true,
            priceDelta: true,
            optionId: true,
            option: { select: { id: true, name: true, productId: true } }
          }
        })
      : [];
    const byValueId = new Map(values.map((v) => [v.id, v]));

    const items = input.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      notes: item.notes ?? null,
      options: item.options.flatMap((group) =>
        group.valueIds.map((valueId) => {
          const value = byValueId.get(valueId);
          if (!value || value.optionId !== group.optionId) {
            throw new ApiError("VALIDATION_ERROR", "Una de las opciones elegidas ya no existe.");
          }
          if (value.option.productId !== item.productId) {
            throw new ApiError("VALIDATION_ERROR", "Una opción no corresponde al producto elegido.");
          }
          return {
            valueId: value.id,
            optionName: value.option.name,
            valueName: value.name,
            priceDelta: toNumber(value.priceDelta)
          };
        })
      )
    }));

    const payload = {
      businessId,
      customerName: input.customerName ?? null,
      customerPhone: input.customerPhone ?? null,
      paymentMethod: input.paymentMethod,
      discountTotal: input.discountTotal,
      notes: input.notes ?? null,
      items
    };
    const rows = await tx.$queryRaw<{ result: { id: string } }[]>`
      select public.create_manual_sale(${JSON.stringify(payload)}::jsonb) as result`;
    return reload(tx, businessId, rows[0]!.result.id);
  });
}

// ── Comprobantes de pago ────────────────────────────────────────────────────

/** URLs firmadas del bucket privado: un comprobante nunca queda público. */
export async function listPaymentProofs({ ctx, businessId }: BusinessScope, orderId: string) {
  const rows = await withDb(ctx, async (tx) => {
    const exists = await tx.order.count({ where: { id: orderId, businessId } });
    if (exists === 0) throw notFound("El pedido no existe.");
    return tx.orderPaymentProof.findMany({ where: { orderId, businessId }, orderBy: { createdAt: "desc" } });
  });
  return Promise.all(
    rows.map(async (p) => ({
      id: p.id,
      status: p.status as "pending" | "approved" | "rejected",
      mediaType: p.mediaType,
      createdAt: p.createdAt,
      reviewedAt: p.reviewedAt,
      url: await presignGet("private", p.storagePath)
    }))
  );
}

/** Aprobar un comprobante NO marca el pedido pagado: eso es `mark-paid`. */
export async function reviewPaymentProof(
  { ctx, businessId }: BusinessScope,
  id: string,
  status: "approved" | "rejected",
  reviewerId: string
) {
  const row = await withDb(ctx, async (tx) => {
    const { count } = await tx.orderPaymentProof.updateMany({
      where: { id, businessId },
      data: { status, reviewedAt: new Date(), reviewedBy: reviewerId }
    });
    if (count === 0) throw notFound("El comprobante no existe.");
    return tx.orderPaymentProof.findUniqueOrThrow({ where: { id } });
  });
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status as "pending" | "approved" | "rejected",
    mediaType: row.mediaType,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    url: await presignGet("private", row.storagePath)
  };
}
