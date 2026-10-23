import { z } from "zod";
import { withDb } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import type { BusinessScope } from "../../lib/request.js";
import { updateCustomerBody } from "./schemas.js";
import { get } from "./service.js";

export const rowsBody = z.object({ rows: z.array(z.record(z.string().max(1000))).min(1).max(1000), preview: z.boolean().default(true) }).strict();
type Row = Record<string, string>;
export const createBody = updateCustomerBody.refine(body => body.removedAddressIds.length === 0 && body.addresses.every(address => !address.id), "Un cliente nuevo no puede usar direcciones existentes.");

export async function create(scope: BusinessScope, input: z.infer<typeof createBody>) {
  const id = await withDb(scope.ctx, async tx => {
    const customer = await tx.customer.create({ data: { businessId: scope.businessId, name: input.name, phone: input.phone, email: input.email } });
    for (const { label, street, city, details } of input.addresses) await tx.customerAddress.create({ data: { businessId: scope.businessId, customerId: customer.id, label, street, city, details } });
    return customer.id;
  });
  return get(scope, id);
}

export async function exportPage(scope: BusinessScope, page: number) {
  return withDb(scope.ctx, async tx => {
    const [data, total] = await Promise.all([
      tx.customer.findMany({ where: { businessId: scope.businessId }, include: { addresses: true }, orderBy: { id: "asc" }, skip: (page - 1) * 100, take: 100 }),
      tx.customer.count({ where: { businessId: scope.businessId } })
    ]);
    return { data: data.map(c => ({ name: c.name, phone: c.phone, email: c.email, addresses: c.addresses.map(a => ({ label: a.label, street: a.street, city: a.city, details: a.details })) })), meta: { pages: Math.max(1, Math.ceil(total / 100)), total } };
  });
}

export async function importRows(scope: BusinessScope, rows: Row[], preview: boolean) {
  const issues: { row: number; message: string }[] = [];
  const grouped = new Map<string, z.infer<typeof createBody>>();
  rows.forEach((row, index) => {
    const parsed = createBody.safeParse({ name: row.nombre, phone: row.telefono, email: row.email || null, addresses: row.direccion ? [{ label: row.etiqueta || "Principal", street: row.direccion, city: row.ciudad || null, details: row.indicaciones || null }] : [], removedAddressIds: [] });
    if (!parsed.success) { issues.push({ row: index + 2, message: parsed.error.issues.map(i => i.message).join(" ") }); return; }
    if (!row.direccion && (row.ciudad || row.indicaciones || row.etiqueta)) { issues.push({ row: index + 2, message: "Completá la dirección o dejá vacíos sus campos." }); return; }
    const current = grouped.get(parsed.data.phone);
    if (current && (current.name !== parsed.data.name || current.email !== parsed.data.email)) issues.push({ row: index + 2, message: "El teléfono se repite con distinto nombre o email." });
    else if (current) {
      for (const address of parsed.data.addresses) if (!current.addresses.some(a => JSON.stringify(a) === JSON.stringify(address))) current.addresses.push(address);
      if (current.addresses.length > 100) issues.push({ row: index + 2, message: "Un cliente no puede tener más de 100 direcciones." });
    } else grouped.set(parsed.data.phone, parsed.data);
  });
  if (issues.length) return { created: 0, skipped: 0, total: grouped.size, issues };
  return withDb(scope.ctx, async tx => {
    const existing = await tx.customer.findMany({ where: { businessId: scope.businessId, phone: { in: [...grouped.keys()] } }, select: { phone: true } });
    const phones = new Set(existing.map(c => c.phone));
    const fresh = [...grouped.values()].filter(c => !phones.has(c.phone));
    if (!preview) for (const customer of fresh) {
      try {
        const created = await tx.customer.create({ data: { businessId: scope.businessId, name: customer.name, phone: customer.phone, email: customer.email } });
        for (const { label, street, city, details } of customer.addresses) await tx.customerAddress.create({ data: { businessId: scope.businessId, customerId: created.id, label, street, city, details } });
      } catch { throw new ApiError("CONFLICT", "No se guardó el archivo. Los datos cambiaron; volvé a revisar la importación."); }
    }
    return { created: fresh.length, skipped: existing.length, total: grouped.size, issues: [] };
  });
}
