import { withDb } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";
import type { BusinessScope } from "../../lib/request.js";
import type { UpdateCustomerBody } from "./schemas.js";

export async function saveCustomer({ ctx, businessId }: BusinessScope, id: string, body: UpdateCustomerBody) {
  return withDb(ctx, async tx => {
    // This update locks the customer until the whole edit commits or rolls back.
    const updated = await tx.customer.updateMany({ where: { id, businessId }, data: {
      name: body.name, phone: body.phone, email: body.email, updatedAt: new Date()
    } });
    if (!updated.count) throw notFound("El cliente no existe.");
    const touched = [...new Set([...body.addresses.flatMap(item => item.id ? [item.id] : []), ...body.removedAddressIds])];
    const owned = await tx.customerAddress.count({ where: { id: { in: touched }, customerId: id, businessId } });
    if (owned !== touched.length) throw notFound("Una de las direcciones ya no está disponible. Volvé a abrir el editor.");
    for (const address of body.addresses) {
      const { id: addressId, ...data } = address;
      if (addressId) await tx.customerAddress.updateMany({ where: { id: addressId, customerId: id, businessId }, data: { ...data, updatedAt: new Date() } });
      else await tx.customerAddress.create({ data: { ...data, customerId: id, businessId } });
    }
    if (body.removedAddressIds.length) await tx.customerAddress.deleteMany({ where: { id: { in: body.removedAddressIds }, customerId: id, businessId } });
  });
}
