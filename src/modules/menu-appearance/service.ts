import { withDb, type Tx } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import type { BusinessScope } from "../../lib/request.js";
import { readAppearance, type Appearance } from "./schemas.js";
import * as repo from "./repo.js";

async function snapshot(tx: Tx, businessId: string) {
  const [business, draft] = await repo.read(tx, businessId);
  if (!business) throw notFound("No encontramos el negocio.");
  const published = readAppearance(business.menuAppearance);
  return { draft: draft ? readAppearance(draft.settings) : published, published,
    revision: draft?.revision ?? 0, updatedAt: draft?.updatedAt ?? null, publishedAt: draft?.publishedAt ?? null };
}
const conflict = () => new ApiError("CONFLICT", "La apariencia cambió en otra sesión. Recargá el borrador antes de continuar.");
export const get = ({ ctx, businessId }: BusinessScope) => withDb(ctx, tx => snapshot(tx, businessId));
export const save = ({ ctx, businessId }: BusinessScope, input: { revision: number; settings: Appearance }) => withDb(ctx, async tx => {
  if (!(await repo.save(tx, businessId, input.revision, input.settings)).count) throw conflict();
  return snapshot(tx, businessId);
});
export const publish = ({ ctx, businessId }: BusinessScope, revision: number) => withDb(ctx, async tx => {
  // Claim this exact saved revision first. The row lock serializes saves and publication.
  if (!(await repo.claimPublication(tx, businessId, revision)).count) throw conflict();
  const draft = await repo.readDraft(tx, businessId);
  if (!(await repo.publish(tx, businessId, readAppearance(draft.settings))).count) throw notFound();
  return snapshot(tx, businessId);
});
