// Cálculo y validación de un pedido — port de `buildOrderPayload` de la Edge
// Function `create-order` (docs/api.md §13).
//
// Es el ÚNICO lugar donde se calcula un total. Lo usan el checkout público y la
// confirmación del borrador de WhatsApp: ni el front ni el agente mandan
// precios, mandan productos. Regla 10 de CLAUDE.md.
import type { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";

export type PaymentMethodInput = "cash" | "transfer" | "mercadopago";

export interface PricingItem {
  productId: string;
  quantity: number;
  optionValueIds?: string[];
  notes?: string | null;
}

export interface PricingInput {
  customer: { name: string; phone: string };
  orderType: "delivery" | "takeaway";
  deliveryAddress?: string | null;
  notes?: string | null;
  couponCode?: string | null;
  paymentMethod: PaymentMethodInput;
  items: PricingItem[];
}

export interface PricedOption {
  valueId: string;
  optionName: string;
  valueName: string;
  priceDelta: number;
}

export interface PricedItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  notes: string | null;
  options: PricedOption[];
}

/** Payload exacto que espera la función SQL `persist_order`. */
export interface OrderPayload {
  businessId: string;
  customerName: string;
  customerPhone: string;
  orderType: "delivery" | "takeaway";
  deliveryAddress: string;
  city: string | null;
  notes: string;
  paymentMethod: PaymentMethodInput;
  subtotal: number;
  deliveryFee: number;
  discountTotal: number;
  total: number;
  couponId: string | null;
  couponCode: string | null;
  orderCode: string;
  items: PricedItem[];
}

export type PricingBusiness = Pick<
  Prisma.BusinessGetPayload<object>,
  "id" | "city" | "minimumOrderAmount" | "deliveryFee"
>;

/** Errores de checkout: el cliente final los lee tal cual. */
function invalid(message: string): ApiError {
  return new ApiError("VALIDATION_ERROR", message);
}

const money = (value: number) => Math.round(value * 100) / 100;

const pesos = (value: number) => `$${money(value).toLocaleString("es-AR")}`;

// ── Piezas reutilizables ────────────────────────────────────────────────────

export async function uniqueOrderCode(tx: Tx): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = `TK-${Math.floor(Math.random() * 900_000) + 100_000}`;
    const existing = await tx.order.count({ where: { orderCode: code } });
    if (existing === 0) return code;
  }
  throw new ApiError("INTERNAL", "No se pudo generar el código del pedido. Probá de nuevo.");
}

type CouponRow = Prisma.CouponGetPayload<object>;

/**
 * Mismas reglas que el checkout. No distingue "no existe" de "inactivo": un
 * cupón ajeno no se confirma probando códigos.
 */
export async function validateCoupon(tx: Tx, businessId: string, rawCode: string, subtotal: number): Promise<CouponRow> {
  const code = rawCode.trim().toUpperCase();
  const coupon = await tx.coupon.findFirst({ where: { businessId, code, isActive: true } });
  if (!coupon) throw invalid("El cupón no existe o no está activo. Revisá el código o continuá sin cupón.");

  const now = Date.now();
  if (toNumber(coupon.minimumOrderAmount) > subtotal) {
    throw invalid(`El cupón requiere un mínimo de ${pesos(toNumber(coupon.minimumOrderAmount))}. Agregá algo más o quitá el cupón.`);
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw invalid("El cupón ya alcanzó su límite de usos. Quitalo para continuar.");
  }
  if (coupon.startsAt && coupon.startsAt.getTime() > now) {
    throw invalid("El cupón todavía no está disponible. Quitalo para continuar.");
  }
  if (coupon.endsAt && coupon.endsAt.getTime() < now) {
    throw invalid("El cupón está vencido. Quitalo para continuar.");
  }
  return coupon;
}

/** Nunca descuenta más que el subtotal. */
export function calculateDiscount(coupon: Pick<CouponRow, "discountType" | "discountValue">, subtotal: number): number {
  const value = toNumber(coupon.discountValue);
  if (coupon.discountType === "percent") return money(Math.min(subtotal, subtotal * (value / 100)));
  return money(Math.min(subtotal, value));
}

export async function assertPaymentMethodEnabled(tx: Tx, businessId: string, method: PaymentMethodInput): Promise<void> {
  const settings = await tx.paymentSettings.findUnique({
    where: { businessId },
    select: { cashEnabled: true, transferEnabled: true, mercadopagoEnabled: true }
  });
  const enabled: Record<PaymentMethodInput, boolean> = {
    cash: settings?.cashEnabled ?? true,
    transfer: settings?.transferEnabled ?? true,
    mercadopago: settings?.mercadopagoEnabled ?? false
  };
  if (!enabled[method]) {
    throw invalid("El medio de pago seleccionado no está disponible. Elegí otro medio de pago.");
  }
}

const productWithOptions = {
  include: { options: { include: { values: true } } }
} satisfies { include: Prisma.ProductInclude };

type ProductRow = Prisma.ProductGetPayload<typeof productWithOptions>;

/**
 * Valida un item contra el producto real y devuelve su precio.
 * Chequea disponibilidad, cantidad, stock (producto y valores), obligatoriedad
 * y mínimos/máximos de cada grupo de opciones.
 */
function priceItem(product: ProductRow, item: PricingItem): PricedItem {
  if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
    throw invalid("Revisá las cantidades del carrito.");
  }
  // Solo cuenta el stock de lo que el negocio decidió controlar (migración 0005).
  if (product.trackStock && product.stockQuantity < item.quantity) {
    throw invalid(`No hay stock suficiente de ${product.name}. Bajá la cantidad o quitá el producto.`);
  }

  const selectedIds = new Set(item.optionValueIds ?? []);
  const options: PricedOption[] = [];

  for (const option of product.options) {
    const selected = option.values.filter((value) => selectedIds.has(value.id) && value.isAvailable);
    if (selected.length < option.minSelect || selected.length > option.maxSelect || (option.isRequired && selected.length === 0)) {
      throw invalid(`Revisá las opciones de ${product.name}. Hay una selección obligatoria o un máximo sin cumplir.`);
    }
    for (const value of selected) {
      if (value.trackStock && value.stockQuantity < item.quantity) {
        throw invalid(`No hay stock suficiente de ${value.name}. Elegí otra opción o bajá la cantidad.`);
      }
      options.push({
        valueId: value.id,
        optionName: option.name,
        valueName: value.name,
        priceDelta: toNumber(value.priceDelta)
      });
    }
  }

  // Un id que no pertenece a este producto (o a un valor no disponible) no se
  // ignora en silencio: el carrito quedó viejo y hay que refrescarlo.
  const knownIds = new Set(product.options.flatMap((option) => option.values.map((value) => value.id)));
  if ([...selectedIds].some((id) => !knownIds.has(id))) {
    throw invalid("Una opción seleccionada ya no está disponible. Actualizá el carrito.");
  }

  const unitPrice = money(toNumber(product.price) + options.reduce((sum, option) => sum + option.priceDelta, 0));
  return {
    productId: product.id,
    productName: product.name,
    quantity: item.quantity,
    unitPrice,
    totalPrice: money(unitPrice * item.quantity),
    notes: item.notes ?? null,
    options
  };
}

/**
 * Arma el payload de `persist_order`. No escribe nada: solo lee y calcula.
 * Corre dentro de la transacción de quien llama, con contexto `service_role`.
 */
export async function buildOrderPayload(tx: Tx, business: PricingBusiness, input: PricingInput): Promise<OrderPayload> {
  if (!input.items.length) throw invalid("Tu carrito está vacío. Volvé al menú y agregá productos.");
  if (!input.customer.name?.trim() || !input.customer.phone?.trim()) {
    throw invalid("Completá tu nombre y WhatsApp para confirmar el pedido.");
  }
  if (input.orderType === "delivery" && !input.deliveryAddress?.trim()) {
    throw invalid("Ingresá la dirección de entrega para continuar.");
  }

  await assertPaymentMethodEnabled(tx, business.id, input.paymentMethod);

  const productIds = [...new Set(input.items.map((item) => item.productId))];
  const products = await tx.product.findMany({
    where: { businessId: business.id, id: { in: productIds }, isAvailable: true },
    ...productWithOptions
  });
  if (products.length !== productIds.length) {
    throw invalid("Uno o más productos ya no están disponibles. Actualizá el carrito y volvé a intentar.");
  }
  const byId = new Map(products.map((product) => [product.id, product]));

  let subtotal = 0;
  const items = input.items.map((item) => {
    const product = byId.get(item.productId);
    if (!product) throw invalid("Uno de los productos del carrito ya no está disponible.");
    const priced = priceItem(product, item);
    subtotal = money(subtotal + priced.totalPrice);
    return priced;
  });

  const minimum = toNumber(business.minimumOrderAmount);
  if (subtotal < minimum) {
    throw invalid(`El pedido mínimo es de ${pesos(minimum)}. Agregá algo más para confirmar.`);
  }

  const deliveryFee = input.orderType === "delivery" ? toNumber(business.deliveryFee) : 0;
  const coupon = input.couponCode ? await validateCoupon(tx, business.id, input.couponCode, subtotal) : null;
  const discountTotal = coupon ? calculateDiscount(coupon, subtotal) : 0;

  return {
    businessId: business.id,
    customerName: input.customer.name.trim(),
    customerPhone: input.customer.phone.trim(),
    orderType: input.orderType,
    deliveryAddress: input.deliveryAddress?.trim() || "",
    city: business.city,
    notes: input.notes?.trim() || "",
    paymentMethod: input.paymentMethod,
    subtotal,
    deliveryFee,
    discountTotal,
    total: money(Math.max(0, subtotal + deliveryFee - discountTotal)),
    couponId: coupon?.id ?? null,
    couponCode: coupon?.code ?? null,
    orderCode: await uniqueOrderCode(tx),
    items
  };
}

export interface PersistedOrder {
  id: string;
  orderCode: string;
  status: string;
  total: number;
  discountTotal: number;
  loyaltyPointsEarned: number;
}

/**
 * Llama a `persist_order` (SECURITY DEFINER): descuenta stock, crea o actualiza
 * el cliente, arma el pedido con sus items y opciones, suma puntos y usa el
 * cupón. Todo en una sola transacción de Postgres.
 */
export async function persistOrder(
  tx: Tx,
  payload: OrderPayload & { source?: "web" | "whatsapp"; conversationId?: string | null }
): Promise<PersistedOrder> {
  const rows = await tx.$queryRaw<{ result: PersistedOrder }[]>`
    select public.persist_order(${JSON.stringify(payload)}::jsonb) as result`;
  const result = rows[0]!.result;
  return {
    ...result,
    total: Number(result.total),
    discountTotal: Number(result.discountTotal),
    loyaltyPointsEarned: Number(result.loyaltyPointsEarned)
  };
}
