// docs/api.md §13. Mensajes pensados para el cliente final, no para un dev.
import { z } from "zod";
import { money, uuid } from "../../lib/validation.js";

export const slugParams = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "Falta el negocio.")
    .max(80, "Falta el negocio.")
    .regex(/^[a-z0-9-]+$/, "No encontramos este menú.")
});

export const slugIdParams = slugParams.extend({ id: uuid("No encontramos el producto.") });

export const slugCodeParams = slugParams.extend({
  code: z
    .string()
    .trim()
    .min(3, "Revisá el código del pedido.")
    .max(20, "Revisá el código del pedido.")
});

export const validateCouponSchema = z.object({
  code: z.string().trim().min(1, "Escribí el código del cupón.").max(40, "Ese código es demasiado largo."),
  subtotal: money("El subtotal")
});

const checkoutItemSchema = z.object({
  productId: uuid("Uno de los productos del carrito ya no está disponible."),
  quantity: z.coerce
    .number({ invalid_type_error: "Revisá las cantidades del carrito." })
    .int("Revisá las cantidades del carrito.")
    .min(1, "Revisá las cantidades del carrito.")
    .max(50, "El máximo por producto es 50 unidades."),
  optionValueIds: z.array(uuid("Una opción seleccionada ya no está disponible.")).max(30).optional(),
  notes: z.string().trim().max(300, "La aclaración es demasiado larga.").nullable().optional()
});

export const checkoutSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2, "Escribí tu nombre.").max(120, "El nombre es demasiado largo."),
    phone: z.string().trim().min(6, "Escribí tu WhatsApp.").max(30, "Revisá el número de WhatsApp.")
  }),
  orderType: z.enum(["delivery", "takeaway"], { errorMap: () => ({ message: "Elegí envío o retiro." }) }),
  deliveryAddress: z.string().trim().max(300, "La dirección es demasiado larga.").nullable().optional(),
  notes: z.string().trim().max(500, "La aclaración es demasiado larga.").nullable().optional(),
  couponCode: z.string().trim().max(40, "Ese código es demasiado largo.").nullable().optional(),
  // mercadopago queda afuera hasta que esté integrado el cobro.
  paymentMethod: z.enum(["cash", "transfer"], {
    errorMap: () => ({ message: "El medio de pago seleccionado no está disponible. Elegí otro medio de pago." })
  }),
  items: z.array(checkoutItemSchema).min(1, "Tu carrito está vacío. Volvé al menú y agregá productos.").max(60)
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type ValidateCouponInput = z.infer<typeof validateCouponSchema>;
