import { withDb } from "../../lib/db.js";
import type { BusinessScope } from "../../lib/request.js";
import { productInclude } from "./products.service.js";
import type { PosProductsQuery } from "./schemas.js";

export function findPage({ ctx, businessId }: BusinessScope, q: PosProductsQuery) {
  return withDb(ctx, tx => tx.product.findMany({
    where: {
      businessId,
      isAvailable: true,
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.search ? { OR: [
        { name: { contains: q.search, mode: "insensitive" as const } },
        { barcode: { contains: q.search, mode: "insensitive" as const } }
      ] } : {})
    },
    include: productInclude,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    skip: q.offset,
    take: q.limit + 1
  }));
}
