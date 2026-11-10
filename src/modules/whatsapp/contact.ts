import type { Tx } from "../../lib/db.js";

export function whatsappPhoneVariants(phone: string | null | undefined) {
  const digits = /^\+?([1-9]\d{6,14})$/.exec(phone ?? "")?.[1];
  return digits ? [digits, `+${digits}`] : [];
}

// A live case or human handoff takes precedence over the date of an old duplicate.
export const contactConversationOrder = [
  { lastMessageAt: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "desc" }
] as const;

export async function findConversationForContact(tx: Tx, businessId: string, contactId: string, phone?: string | null) {
  const variants = whatsappPhoneVariants(phone);
  // Different provider IDs for the same number can arrive at the same time.
  if (variants.length) {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`whatsapp:${businessId}:${variants[0]}`}, 0))`;
  }
  const exact = await tx.whatsappConversation.findUnique({ where: { businessId_contactId: { businessId, contactId } } });
  const phones = variants.length ? variants : whatsappPhoneVariants(exact?.phone);
  if (!phones.length) return exact;
  const samePhone = { businessId, phone: { in: phones } };
  const orderBy = [...contactConversationOrder];
  return await tx.whatsappConversation.findFirst({
    where: { ...samePhone, OR: [{ status: "handoff" }, { currentCaseId: { not: null } }] },
    orderBy
  }) ?? await tx.whatsappConversation.findFirst({ where: samePhone, orderBy }) ?? exact;
}
