import { z } from "zod";

export const listCustomersQuery = z.object({
  search: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;
