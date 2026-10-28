import type { Tx } from "../../lib/db.js";
import type { Appearance } from "./schemas.js";

export const read = (tx: Tx, businessId: string) => Promise.all([
  tx.business.findUnique({ where: { id: businessId }, select: { menuAppearance: true } }),
  tx.menuAppearanceDraft.findUnique({ where: { businessId } })
]);
export async function save(tx: Tx, businessId: string, revision: number, settings: Appearance) {
  if (revision === 0) await tx.menuAppearanceDraft.createMany({ data: [{ businessId, settings }], skipDuplicates: true });
  return tx.menuAppearanceDraft.updateMany({
    where: { businessId, revision }, data: { settings, revision: { increment: 1 }, updatedAt: new Date() }
  });
}
export async function claimPublication(tx: Tx, businessId: string, revision: number) {
  return tx.menuAppearanceDraft.updateMany({
    where: { businessId, revision }, data: { revision: { increment: 1 }, publishedAt: new Date() }
  });
}
export const readDraft = (tx: Tx, businessId: string) => tx.menuAppearanceDraft.findUniqueOrThrow({ where: { businessId } });
export const publish = (tx: Tx, businessId: string, settings: Appearance) => tx.business.updateMany({
  where: { id: businessId }, data: { menuAppearance: settings }
});
