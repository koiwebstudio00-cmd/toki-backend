import type { BusinessScope } from "../../lib/request.js";
import { findPage } from "./pos.repo.js";
import { toProductDto } from "./products.service.js";
import type { PosProductsQuery } from "./schemas.js";

export async function list(scope: BusinessScope, query: PosProductsQuery) {
  const rows = await findPage(scope, query);
  return {
    data: rows.slice(0, query.limit).map(toProductDto),
    nextOffset: rows.length > query.limit ? query.offset + query.limit : null
  };
}
