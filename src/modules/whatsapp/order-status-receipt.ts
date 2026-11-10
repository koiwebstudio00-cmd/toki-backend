import type { Prisma } from "@prisma/client";

export const orderStatusReceiptIntent = "internal_order_status_send";

export const visibleWhatsappMessages = {
  OR: [{ aiIntent: null }, { aiIntent: { not: orderStatusReceiptIntent } }]
} satisfies Prisma.WhatsappMessageWhereInput;
