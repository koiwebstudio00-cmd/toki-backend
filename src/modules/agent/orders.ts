// Pedidos ya hechos desde el agente (v3, fase V3): modificar, cancelar,
// derivar con un caso y datos del reembolso. Plan: toki-agents/docs/12-plan-agente-v3.md
// §3.4 y §4.4–4.5.
//
// Reglas (las decide el servidor, no el modelo):
// - Cancelar: solo en `pending` (D3). Devuelve stock, cupón y puntos; si estaba
//   pagado, deja un reembolso pendiente.
// - Modificar: en `pending`, `confirmed` o `preparing` (D4). Un pedido pagado
//   puede quedar con saldo a pagar o con un reembolso pendiente.
import type { Prisma } from "@prisma/client";
import { systemCtx, type Tx, withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import { isOpen } from "../businesses/service.js";
import { assertPaymentMethodEnabled, calculateDiscount, type PaymentMethodInput, priceItems } from "../orders/pricing.js";
import { statusLabel } from "./context.js";
import * as repo from "./repo.js";
import type { CancelOrderInput, HandoffInput, ModifyOrderInput, RefundDestinationInput } from "./schemas.js";
import { resolveOptionRefs, resolveProductRef } from "./service.js";

type Json = Record<string, unknown>;

export const EDITABLE_STATUSES = ["pending", "confirmed", "preparing"] as const;
export const CANCELABLE_STATUSES = ["pending"] as const;

const isEditable = (status: string) => (EDITABLE_STATUSES as readonly string[]).includes(status);
const isCancelable = (status: string) => (CANCELABLE_STATUSES as readonly string[]).includes(status);

const money = (value: number) => Math.round(value * 100) / 100;

/**
 * Suma a un pedido de `agent_order_json` lo que el agente necesita saber sin
 * deducirlo: estado en palabras y si se puede modificar o cancelar con las
 * reglas de v3 (el `editable` de la función SQL es el de v2 y se pisa).
 */
export function decorateOrder(order: Json | null | undefined): Json | null {
  if (!order) return null;
  const status = String(order.status ?? "");
  order.status_label = statusLabel(status, order.order_type as string | null);
  order.editable = isEditable(status);
  order.cancelable = isCancelable(status);
  return order;
}

/** Motivo legible de por qué un pedido no se puede tocar. */
function lockedReason(status: string, action: "modificar" | "cancelar"): string {
  switch (status) {
    case "confirmed":
    case "preparing":
      return "El local ya aceptó el pedido, así que la cancelación la tiene que ver una persona del local.";
    case "ready":
      return `El pedido ya está listo, así que no lo puedo ${action}: lo tiene que ver una persona del local.`;
    case "out_for_delivery":
      return `El pedido ya salió, así que no lo puedo ${action}: lo tiene que ver una persona del local.`;
    case "delivered":
      return "Ese pedido ya se entregó.";
    case "cancelled":
      return "Ese pedido está cancelado.";
    default:
      return `No puedo ${action} ese pedido.`;
  }
}

const fail = (error: string) => ({ ok: false as const, error });

/** Una validación que falla a mitad de camino: corta la transacción sin escribir nada. */
class Rejected extends Error {
  constructor(
    message: string,
    readonly extra: Json = {}
  ) {
    super(message);
  }
}

async function run<T>(fn: (tx: Tx) => Promise<T>) {
  try {
    return await withDb(systemCtx, fn);
  } catch (err) {
    if (err instanceof Rejected) return { ok: false as const, error: err.message, ...err.extra };
    // Errores de validación del cálculo de pedidos (stock, opciones): legibles.
    if (err instanceof ApiError && err.code === "VALIDATION_ERROR") return fail(err.message);
    throw err;
  }
}

// ── Modificar ───────────────────────────────────────────────────────────────

interface Changes {
  added: { producto: string; cantidad: number; opciones: string[] }[];
  removed: { producto: string; cantidad: number }[];
  quantity: { producto: string; antes: number; despues: number }[];
  fields: { campo: string; antes: string | null; despues: string | null }[];
  coupon_removed?: string;
}

/**
 * Cambia un pedido hecho en una sola llamada: sumar, sacar, cambiar cantidades,
 * entrega, dirección y medio de pago. Todo se valida antes de escribir; si algo
 * no se puede, no se toca nada.
 */
export async function modifyOrder(input: ModifyOrderInput) {
  return run(async (tx) => {
    if (!(await repo.conversationBelongs(tx, input.businessId, input.conversationId))) {
      throw new Rejected("Conversacion invalida.");
    }
    const orderId = await repo.resolveOrderId(tx, input.businessId, input.conversationId, input.orderCode);
    if (!orderId) throw new Rejected("No encontré ese pedido.");
    await repo.lockOrder(tx, orderId);
    const order = await repo.orderForChange(tx, orderId);

    if (!isEditable(order.status)) {
      throw new Rejected(lockedReason(order.status, "modificar"), { derivar: true });
    }

    const nothing =
      !input.add.length &&
      !input.remove.length &&
      !input.quantities.length &&
      !input.orderType &&
      !input.deliveryAddress &&
      !input.paymentMethod;
    if (nothing) throw new Rejected("No me dijiste qué cambiar del pedido.");

    const changes: Changes = { added: [], removed: [], quantity: [], fields: [] };
    const items = new Map(order.items.map((item) => [item.id, item]));
    const newQuantity = new Map(order.items.map((item) => [item.id, item.quantity]));
    const restock: { orderItemId: string; quantity: number }[] = [];
    const deduct: { productId: string | null; optionValueIds: string[]; quantity: number }[] = [];

    const itemFor = (id: string) => {
      const item = items.get(id);
      if (!item) throw new Rejected("Ese producto ya no está en el pedido.");
      return item;
    };

    // Sacar.
    for (const id of input.remove) {
      const item = itemFor(id);
      if (newQuantity.get(id) === 0) continue;
      newQuantity.set(id, 0);
      restock.push({ orderItemId: id, quantity: item.quantity });
      changes.removed.push({ producto: item.productName, cantidad: item.quantity });
    }

    // Cantidades.
    for (const { itemId, quantity } of input.quantities) {
      const item = itemFor(itemId);
      if (newQuantity.get(itemId) === 0 || quantity === item.quantity) continue;
      if (quantity === 0) {
        newQuantity.set(itemId, 0);
        restock.push({ orderItemId: itemId, quantity: item.quantity });
        changes.removed.push({ producto: item.productName, cantidad: item.quantity });
        continue;
      }
      const diff = quantity - item.quantity;
      if (diff < 0) {
        restock.push({ orderItemId: itemId, quantity: -diff });
      } else {
        const valueIds = item.options.map((o) => o.optionValueId).filter((id): id is string => Boolean(id));
        const [product, values] = await repo.stockFor(tx, input.businessId, item.productId, valueIds);
        if (product?.trackStock && product.stockQuantity < diff) {
          throw new Rejected(`Solo quedan ${product.stockQuantity} unidades más de ${product.name}.`);
        }
        const shortValue = values.find((v) => v.trackStock && v.stockQuantity < diff);
        if (shortValue) throw new Rejected(`Solo quedan ${shortValue.stockQuantity} más de ${shortValue.name}.`);
        deduct.push({ productId: item.productId, optionValueIds: valueIds, quantity: diff });
      }
      newQuantity.set(itemId, quantity);
      changes.quantity.push({ producto: item.productName, antes: item.quantity, despues: quantity });
    }

    // Sumar: mismas reglas que el checkout.
    const toPrice = [];
    for (const add of input.add) {
      const product = await resolveProductRef(tx, input.businessId, add.productId);
      if (!product.ok) throw new Rejected(product.error);
      const options = await resolveOptionRefs(tx, input.businessId, add.optionValueIds);
      if (!options.ok) throw new Rejected(options.error);
      toPrice.push({ productId: product.id, quantity: add.quantity, optionValueIds: options.ids, notes: add.notes ?? null });
    }
    const priced = toPrice.length ? await priceItems(tx, input.businessId, toPrice) : [];
    for (const p of priced) {
      changes.added.push({ producto: p.productName, cantidad: p.quantity, opciones: p.options.map((o) => o.valueName) });
    }

    const kept = order.items.filter((item) => (newQuantity.get(item.id) ?? 0) > 0);
    if (!kept.length && !priced.length) {
      throw new Rejected("No puedo dejar el pedido vacío. Si ya no lo quiere, hay que cancelarlo.");
    }

    // Entrega, dirección y pago.
    const orderType = input.orderType ?? order.orderType;
    const address =
      orderType === "takeaway" ? null : (input.deliveryAddress?.trim() || order.deliveryAddress?.trim() || null);
    if (orderType === "delivery" && !address) throw new Rejected("Para mandarlo necesito la dirección de entrega.");
    const paymentMethod = (input.paymentMethod ?? order.paymentMethod) as PaymentMethodInput;
    if (input.paymentMethod && input.paymentMethod !== order.paymentMethod) {
      await assertPaymentMethodEnabled(tx, input.businessId, input.paymentMethod);
    }
    const field = (campo: string, antes: string | null, despues: string | null) => {
      if ((antes ?? null) !== (despues ?? null)) changes.fields.push({ campo, antes, despues });
    };
    field("entrega", order.orderType, orderType);
    field("direccion", order.deliveryAddress, address);
    field("pago", order.paymentMethod, paymentMethod);

    // Totales nuevos, calculados antes de escribir.
    const subtotal = money(
      kept.reduce((sum, item) => sum + toNumber(item.unitPrice) * (newQuantity.get(item.id) ?? 0), 0) +
        priced.reduce((sum, p) => sum + p.totalPrice, 0)
    );
    const minimum = toNumber(order.business.minimumOrderAmount);
    if (subtotal < minimum) {
      throw new Rejected(`Con ese cambio el pedido queda en $ ${subtotal.toLocaleString("es-AR")} y el mínimo es $ ${minimum.toLocaleString("es-AR")}.`);
    }
    const deliveryFee = orderType === "delivery" ? toNumber(order.business.deliveryFee) : 0;
    let discount = 0;
    if (order.coupon) {
      if (subtotal >= toNumber(order.coupon.minimumOrderAmount)) {
        discount = calculateDiscount(order.coupon, subtotal);
      } else {
        changes.coupon_removed = order.coupon.code;
      }
    }
    const total = money(Math.max(0, subtotal + deliveryFee - discount));
    const totalBefore = toNumber(order.total);

    // ── Escritura ──
    if (restock.length) await repo.restock(tx, order.id, restock);
    await repo.deductStock(tx, input.businessId, deduct);

    for (const item of order.items) {
      const quantity = newQuantity.get(item.id) ?? 0;
      if (quantity === 0) {
        await tx.orderItem.delete({ where: { id: item.id } });
      } else if (quantity !== item.quantity) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { quantity, totalPrice: money(toNumber(item.unitPrice) * quantity) }
        });
      }
    }

    for (const p of priced) {
      await tx.orderItem.create({
        data: {
          businessId: input.businessId,
          orderId: order.id,
          productId: p.productId,
          productName: p.productName,
          quantity: p.quantity,
          unitPrice: p.unitPrice,
          totalPrice: p.totalPrice,
          notes: p.notes,
          options: {
            create: p.options.map((o) => ({
              businessId: input.businessId,
              optionName: o.optionName,
              valueName: o.valueName,
              priceDelta: o.priceDelta,
              optionValueId: o.valueId
            }))
          }
        }
      });
    }
    await repo.deductStock(
      tx,
      input.businessId,
      priced.map((p) => ({ productId: p.productId, optionValueIds: p.options.map((o) => o.valueId), quantity: p.quantity }))
    );

    // Pagos: sin pago registrado, el pendiente sigue al total. Pagado: la
    // diferencia queda a pagar o se devuelve.
    const extra: Json = {};
    let paymentStatus = order.paymentStatus;
    if (order.paymentStatus === "paid") {
      const paid = await repo.paidAmount(tx, order.id);
      const diff = money(total - paid);
      if (diff > 0) {
        await tx.payment.create({
          data: { businessId: input.businessId, orderId: order.id, provider: paymentMethod, status: "pending", amount: diff }
        });
        paymentStatus = "pending";
        extra.saldo_pendiente = diff;
      } else if (diff < 0) {
        await tx.orderRefund.create({
          data: {
            businessId: input.businessId,
            orderId: order.id,
            conversationId: input.conversationId,
            amount: -diff,
            reason: "modificacion_baja_total",
            originalPaymentMethod: order.paymentMethod
          }
        });
        extra.reembolso = true;
        extra.monto_reembolso = -diff;
      }
    } else {
      await tx.payment.updateMany({
        where: { orderId: order.id, status: "pending" },
        data: { amount: total, provider: paymentMethod }
      });
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        subtotal,
        deliveryFee,
        discountTotal: discount,
        total,
        orderType,
        deliveryAddress: address,
        paymentMethod,
        paymentStatus,
        ...(changes.coupon_removed ? { couponId: null, couponCode: null } : {}),
        whatsappConversationId: order.whatsappConversationId ?? input.conversationId,
        modifiedAt: new Date(),
        modificationCount: { increment: 1 },
        lastModifiedDuring: order.status
      }
    });
    if (changes.coupon_removed) {
      await tx.coupon.updateMany({ where: { id: order.couponId! }, data: { usedCount: { decrement: 1 } } });
    }

    await tx.orderModification.create({
      data: {
        businessId: input.businessId,
        orderId: order.id,
        source: "whatsapp",
        conversationId: input.conversationId,
        statusAtChange: order.status,
        changes: changes as unknown as Prisma.InputJsonValue,
        subtotalBefore: order.subtotal,
        totalBefore: order.total,
        totalAfter: total
      }
    });
    await tx.orderStatusHistory.create({
      data: {
        businessId: input.businessId,
        orderId: order.id,
        fromStatus: order.status,
        toStatus: order.status,
        note:
          order.status === "preparing"
            ? "Modificado por el cliente vía WhatsApp durante la preparación."
            : "Modificado por el cliente vía WhatsApp."
      }
    });

    return {
      ok: true as const,
      cambios: changes,
      total_anterior: totalBefore,
      total_nuevo: total,
      ...extra,
      pedido: decorateOrder(await repo.orderJson(tx, order.id))
    };
  });
}

// ── Cancelar ────────────────────────────────────────────────────────────────

/**
 * Cancela un pedido que el local todavía no aceptó. Devuelve stock, el uso del
 * cupón y los puntos; si estaba pagado deja un reembolso pendiente para que el
 * agente pida a dónde devolver y derive.
 */
export async function cancelOrder(input: CancelOrderInput) {
  return run(async (tx) => {
    if (!(await repo.conversationBelongs(tx, input.businessId, input.conversationId))) {
      throw new Rejected("Conversacion invalida.");
    }
    const orderId = await repo.resolveOrderId(tx, input.businessId, input.conversationId, input.orderCode);
    if (!orderId) throw new Rejected("No encontré ese pedido.");
    await repo.lockOrder(tx, orderId);
    const order = await repo.orderForChange(tx, orderId);

    if (order.status === "cancelled") {
      return { ok: true as const, yaEstaba: true, orderCode: order.orderCode };
    }
    if (!isCancelable(order.status)) {
      throw new Rejected(lockedReason(order.status, "cancelar"), { derivar: true });
    }

    await tx.order.update({
      where: { id: order.id },
      data: { status: "cancelled", whatsappConversationId: order.whatsappConversationId ?? input.conversationId }
    });
    await tx.orderStatusHistory.create({
      data: {
        businessId: input.businessId,
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "cancelled",
        note: `Cancelado por el cliente vía WhatsApp${input.reason ? `: ${input.reason}` : "."}`
      }
    });
    // Stock, cupón, puntos, quién canceló y reembolso: lo mismo que el panel (0011).
    const effects = await repo.registerCancellation(tx, order.id, "customer_whatsapp", input.reason ?? null, input.conversationId);

    const extra: Json = {};
    if (effects.refund_id) {
      extra.reembolso = true;
      extra.monto_reembolso = Number(effects.refund_amount);
    }

    return { ok: true as const, orderCode: order.orderCode, estado: "cancelado", ...extra };
  });
}

// ── Derivar ─────────────────────────────────────────────────────────────────

const HANDOFF_REASONS = ["cancelacion", "reembolso", "cambio_pedido", "queja", "pedido_humano", "no_puedo_ayudar"] as const;
const ORDER_REASONS = new Set(["cancelacion", "reembolso", "cambio_pedido"]);

/**
 * Pasa la conversación a una persona y deja un caso con el motivo, el pedido
 * (si la derivación es por un pedido) y un resumen de una línea. Si hay un
 * reembolso pendiente de ese pedido, queda atado al caso.
 */
export async function handoff(input: HandoffInput & { conversationId: string }) {
  return run(async (tx) => {
    if (!(await repo.conversationBelongs(tx, input.businessId, input.conversationId))) {
      throw new Rejected("Conversacion invalida.");
    }
    const bot = await repo.botSettings(tx, input.businessId);
    if (bot && !bot.handoffEnabled) {
      throw new Rejected("El local no tiene habilitado pasar la conversación a una persona.");
    }
    const reason = (HANDOFF_REASONS as readonly string[]).includes(input.reason ?? "")
      ? (input.reason as string)
      : "no_puedo_ayudar";

    let orderId: string | null = null;
    if (input.orderCode || ORDER_REASONS.has(reason)) {
      const code = repo.normalizeOrderCode(input.orderCode);
      if (code) {
        orderId = await repo.resolveOrderId(tx, input.businessId, input.conversationId, code);
      } else {
        // Sin código: el último pedido de la conversación, aunque esté cancelado
        // (un reembolso es justamente de un pedido cancelado).
        const last = await tx.order.findFirst({
          where: { businessId: input.businessId, whatsappConversationId: input.conversationId },
          orderBy: { createdAt: "desc" },
          select: { id: true }
        });
        orderId = last?.id ?? (await repo.resolveOrderId(tx, input.businessId, input.conversationId));
      }
    }

    const created = await tx.conversationCase.create({
      data: {
        businessId: input.businessId,
        conversationId: input.conversationId,
        orderId,
        reason,
        summary: input.summary ?? null
      }
    });
    if (orderId) {
      await tx.orderRefund.updateMany({
        where: { orderId, status: "pending", caseId: null },
        data: { caseId: created.id }
      });
    }
    await tx.whatsappConversation.update({
      where: { id: input.conversationId },
      data: { status: "handoff", handoffReason: reason, currentCaseId: created.id }
    });

    const order = orderId ? await tx.order.findUnique({ where: { id: orderId }, select: { orderCode: true } }) : null;
    return {
      ok: true as const,
      motivo: reason,
      caso_id: created.id,
      pedido: order?.orderCode ?? null,
      // Con el local cerrado nadie va a contestar enseguida: el agente lo dice.
      hay_alguien: await isOpen(tx, input.businessId)
    };
  });
}

// ── Reembolso ───────────────────────────────────────────────────────────────

/** Guarda a dónde devolver la plata en el reembolso pendiente de la conversación. */
export async function setRefundDestination(input: RefundDestinationInput) {
  return run(async (tx) => {
    if (!(await repo.conversationBelongs(tx, input.businessId, input.conversationId))) {
      throw new Rejected("Conversacion invalida.");
    }
    const code = repo.normalizeOrderCode(input.orderCode);
    const orderId = code ? await repo.resolveOrderId(tx, input.businessId, input.conversationId, code) : null;
    const refund = await repo.pendingRefund(tx, input.businessId, input.conversationId, orderId);
    if (!refund) throw new Rejected("No hay ningún reembolso pendiente para esta conversación.");

    const destination = {
      ...((refund.destination as Json | null) ?? {}),
      ...(input.alias ? { alias: input.alias } : {}),
      ...(input.cbuCvu ? { cbu_cvu: input.cbuCvu } : {}),
      ...(input.holder ? { holder: input.holder } : {})
    };
    await tx.orderRefund.update({ where: { id: refund.id }, data: { destination } });
    return { ok: true as const, monto: toNumber(refund.amount), destino: destination };
  });
}
