// Casos (derivaciones del agente) y reembolsos, del lado del panel — agente
// v3, fase V3b. Plan: toki-agents/docs/12-plan-agente-v3.md §4.5.
//
// Todo corre como el usuario (RLS): los miembros del negocio leen casos y
// reembolsos y pueden resolverlos (policies de 0010).
import { type Tx, withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import { newRefundProofKey, PRESIGN_TTL_SECONDS, presignGet, presignPut } from "../../lib/r2.js";
import type { BusinessScope } from "../../lib/request.js";
import { REFUND_PROOF_TYPES, type CompleteRefundInput, type ListRefundsQuery } from "./schemas.js";

const userId = (ctx: BusinessScope["ctx"]) => (ctx.role === "authenticated" ? ctx.userId : null);

// ── Casos ───────────────────────────────────────────────────────────────────

/** Da por resuelto un caso. La conversación sigue como esté: tomarla o devolverla es aparte. */
export async function resolveCase({ ctx, businessId }: BusinessScope, id: string, note: string | null | undefined) {
  return withDb(ctx, async (tx) => {
    const current = await tx.conversationCase.findFirst({ where: { id, businessId }, select: { status: true } });
    if (!current) throw notFound("El caso no existe.");
    if (current.status === "resolved") throw new ApiError("CONFLICT", "El caso ya estaba resuelto.");
    const row = await tx.conversationCase.update({
      where: { id },
      data: { status: "resolved", resolvedAt: new Date(), resolvedBy: userId(ctx), resolutionNote: note ?? null }
    });
    return { id: row.id, status: row.status, resolvedAt: row.resolvedAt, resolutionNote: row.resolutionNote };
  });
}

// ── Reembolsos ──────────────────────────────────────────────────────────────

const refundInclude = {
  order: { select: { id: true, orderCode: true, customerName: true, customerPhone: true, total: true, status: true } },
  case: { select: { id: true, reason: true, status: true, conversationId: true } }
} as const;

async function toRefundDto(r: Awaited<ReturnType<typeof findRefunds>>[number]) {
  return {
    id: r.id,
    amount: toNumber(r.amount),
    reason: r.reason as "cancelacion" | "modificacion_baja_total" | "otro",
    status: r.status as "pending" | "completed" | "rejected",
    originalPaymentMethod: r.originalPaymentMethod,
    destination: (r.destination ?? {}) as { alias?: string; cbu_cvu?: string; holder?: string },
    requestedAt: r.requestedAt,
    completedAt: r.completedAt,
    notes: r.notes,
    // El comprobante está en el bucket privado: URL firmada por unos minutos.
    proofUrl: r.proofStoragePath ? await presignGet("private", r.proofStoragePath) : null,
    order: { ...r.order, total: toNumber(r.order.total) },
    case: r.case,
    conversationId: r.conversationId
  };
}

function findRefunds(tx: Tx, businessId: string, q: ListRefundsQuery) {
  return tx.orderRefund.findMany({
    where: { businessId, ...(q.status ? { status: q.status } : {}) },
    include: refundInclude,
    orderBy: { requestedAt: "desc" },
    skip: (q.page - 1) * q.limit,
    take: q.limit
  });
}

export async function listRefunds({ ctx, businessId }: BusinessScope, q: ListRefundsQuery) {
  const [rows, total] = await withDb(ctx, async (tx) => [
    await findRefunds(tx, businessId, q),
    await tx.orderRefund.count({ where: { businessId, ...(q.status ? { status: q.status } : {}) } })
  ]);
  return {
    data: await Promise.all(rows.map(toRefundDto)),
    meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) }
  };
}

async function pendingRefund(tx: Tx, businessId: string, id: string) {
  const refund = await tx.orderRefund.findFirst({ where: { id, businessId } });
  if (!refund) throw notFound("El reembolso no existe.");
  if (refund.status !== "pending") throw new ApiError("CONFLICT", "Ese reembolso ya se cerró.");
  return refund;
}

/** URL para subir el comprobante de la devolución (bucket privado). */
export async function refundProofUpload(
  { ctx, businessId }: BusinessScope,
  id: string,
  contentType: keyof typeof REFUND_PROOF_TYPES
) {
  await withDb(ctx, (tx) => pendingRefund(tx, businessId, id));
  const key = newRefundProofKey(businessId, id, REFUND_PROOF_TYPES[contentType]);
  return {
    uploadUrl: await presignPut("private", key, contentType),
    method: "PUT",
    headers: { "Content-Type": contentType },
    key,
    expiresIn: PRESIGN_TTL_SECONDS
  };
}

/**
 * El local devolvió la plata. Si era por una cancelación, el pedido y sus pagos
 * quedan como reembolsados.
 */
export async function completeRefund({ ctx, businessId }: BusinessScope, id: string, input: CompleteRefundInput) {
  return withDb(ctx, async (tx) => {
    const refund = await pendingRefund(tx, businessId, id);
    // La key la armó el backend en refundProofUpload: no se acepta cualquier ruta.
    if (input.proofKey && !input.proofKey.startsWith(`${businessId}/refund-proofs/${id}/`)) {
      throw new ApiError("VALIDATION_ERROR", "El comprobante no corresponde a este reembolso.");
    }
    await tx.orderRefund.update({
      where: { id },
      data: {
        status: "completed",
        completedAt: new Date(),
        completedBy: userId(ctx),
        proofStoragePath: input.proofKey ?? null,
        notes: input.notes ?? refund.notes
      }
    });
    if (refund.reason === "cancelacion") {
      await tx.order.updateMany({ where: { id: refund.orderId, businessId }, data: { paymentStatus: "refunded" } });
      await tx.payment.updateMany({ where: { orderId: refund.orderId, businessId, status: "paid" }, data: { status: "refunded" } });
    }
    const [row] = await tx.orderRefund.findMany({ where: { id }, include: refundInclude });
    return toRefundDto(row!);
  });
}

/** El local decidió no devolver (por ejemplo, el cliente pagó en efectivo al retirar). */
export async function rejectRefund({ ctx, businessId }: BusinessScope, id: string, notes: string) {
  return withDb(ctx, async (tx) => {
    await pendingRefund(tx, businessId, id);
    await tx.orderRefund.update({
      where: { id },
      data: { status: "rejected", completedAt: new Date(), completedBy: userId(ctx), notes }
    });
    const [row] = await tx.orderRefund.findMany({ where: { id }, include: refundInclude });
    return toRefundDto(row!);
  });
}
