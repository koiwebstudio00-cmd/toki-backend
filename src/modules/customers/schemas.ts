import { z } from "zod";

export const listCustomersQuery = z.object({
  search: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;

const address = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().min(1, "Ingresá un nombre para la dirección.").max(80),
  street: z.string().trim().min(1, "Ingresá la calle y altura.").max(300),
  city: z.string().trim().max(150).nullable(),
  details: z.string().trim().max(500).nullable()
}).strict();

export const updateCustomerBody = z.object({
  name: z.string().trim().min(1, "Ingresá el nombre del cliente.").max(150),
  phone: z.string().trim().max(40).regex(/^\+?[\d\s().-]+$/, "Ingresá un teléfono válido.")
    .transform(value => value.replace(/\D/g, ""))
    .refine(value => /^\d{7,15}$/.test(value), "El teléfono debe tener entre 7 y 15 dígitos."),
  email: z.union([z.string().trim().email("Ingresá un email válido.").max(254), z.literal(""), z.null()])
    .transform(value => value || null),
  addresses: z.array(address).max(100),
  removedAddressIds: z.array(z.string().uuid()).max(100).default([])
}).strict().superRefine((value, ctx) => {
  const ids = value.addresses.flatMap(item => item.id ? [item.id] : []);
  if (new Set(ids).size !== ids.length || ids.some(id => value.removedAddressIds.includes(id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Revisá las direcciones seleccionadas.", path: ["addresses"] });
  }
});
export type UpdateCustomerBody = z.infer<typeof updateCustomerBody>;
