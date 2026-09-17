import { z } from "zod";
import { money, nonNegativeInt, optionalText, queryBoolean, uuid } from "../../lib/validation.js";

const imageUrl = z.string().trim().max(1000).nullable().optional();

// ── Categorías ──────────────────────────────────────────────────────────────

const categoryFields = {
  name: z.string({ required_error: "Completá el nombre de la categoría." }).trim().min(2, "Completá el nombre de la categoría.").max(80),
  description: optionalText(180, "Usá una descripción más corta."),
  imageUrl,
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int("Usá un número entero.").min(0).max(100_000).optional()
};

export const createCategorySchema = z.object(categoryFields);
export const updateCategorySchema = z
  .object(categoryFields)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "No hay cambios para guardar.");
export const reorderCategoriesSchema = z.object({
  ids: z.array(uuid()).min(1).max(500).refine((ids) => new Set(ids).size === ids.length, "Hay categorías repetidas.")
});
export const listCategoriesQuery = z.object({ active: queryBoolean });

// ── Productos ───────────────────────────────────────────────────────────────

const optionValueSchema = z.object({
  id: uuid().optional(),
  name: z.string().trim().min(1, "Completá los nombres de todas las variantes.").max(80),
  priceDelta: money("El precio extra").default(0),
  isAvailable: z.boolean().default(true),
  trackStock: z.boolean().default(true),
  stockQuantity: nonNegativeInt("El stock").default(0),
  lowStockThreshold: nonNegativeInt("La alerta de stock").default(5)
});

const optionSchema = z
  .object({
    id: uuid().optional(),
    name: z.string().trim().min(1, "Completá los nombres de todas las variantes.").max(80),
    type: z.enum(["single", "multiple"]),
    isRequired: z.boolean().default(false),
    minSelect: z.coerce.number().int().min(0).max(50).default(0),
    maxSelect: z.coerce.number().int().min(1).max(50).default(1),
    values: z.array(optionValueSchema).min(1, "Cada grupo necesita al menos una opción.").max(50)
  })
  // Mismas reglas que el editor del front: obligatorio → mínimo 1; único → máximo 1.
  .transform((o) => ({
    ...o,
    minSelect: o.isRequired ? Math.max(1, o.minSelect) : 0,
    maxSelect: o.type === "single" ? 1 : Math.max(1, o.maxSelect)
  }))
  .superRefine((o, ctx) => {
    if (o.maxSelect < o.minSelect) ctx.addIssue({ code: "custom", path: ["maxSelect"], message: "El máximo no puede ser menor que el mínimo." });
    if (o.minSelect > o.values.length) ctx.addIssue({ code: "custom", path: ["minSelect"], message: "El mínimo supera la cantidad de opciones." });
  });

export const productInputSchema = z
  .object({
    categoryId: uuid().nullable().optional(),
    newCategoryName: z.string().trim().min(2).max(80).optional(),
    name: z.string({ required_error: "Completá el nombre del producto." }).trim().min(2, "Completá el nombre del producto.").max(120),
    description: optionalText(500, "Usá una descripción más corta."),
    price: money("El precio"),
    imageUrl,
    isAvailable: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
    preparationMinutes: z.coerce.number().int().min(1).max(600).nullable().optional(),
    barcode: z
      .string()
      .trim()
      .min(4, "El código de barras tiene que tener al menos 4 caracteres.")
      .max(64, "El código de barras es demasiado largo.")
      .optional(),
    trackStock: z.boolean().default(true),
    stockQuantity: nonNegativeInt("El stock").default(0),
    lowStockThreshold: nonNegativeInt("La alerta de stock").default(5),
    sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
    options: z.array(optionSchema).max(20, "Demasiados grupos de opciones.").default([])
  })
  .refine((v) => !(v.categoryId && v.newCategoryName), { message: "Elegí una categoría o creá una nueva, no las dos.", path: ["newCategoryName"] });

export const listProductsQuery = z.object({
  categoryId: uuid().optional(),
  available: queryBoolean,
  featured: queryBoolean,
  lowStock: queryBoolean,
  search: z.string().trim().max(100).optional(),
  barcode: z.string().trim().max(64).optional()
});

export const availabilitySchema = z.object({ isAvailable: z.boolean() });
export const stockSchema = z.object({
  stockQuantity: nonNegativeInt("El stock"),
  trackStock: z.boolean().optional()
});

// ── Ingredientes ────────────────────────────────────────────────────────────

const quantity = (label: string) =>
  z.coerce
    .number({ invalid_type_error: `${label} tiene que ser un número.` })
    .min(0, `${label} no puede ser negativo.`)
    .max(999_999_999)
    .transform((v) => Math.round(v * 1000) / 1000);

const ingredientFields = {
  name: z.string({ required_error: "Completá el nombre." }).trim().min(1, "Completá el nombre.").max(80),
  quantity: quantity("La cantidad"),
  unit: z.enum(["kg", "g", "l", "ml", "unit"], { errorMap: () => ({ message: "Unidad inválida." }) }),
  lowStockThreshold: quantity("La alerta"),
  notes: optionalText(300)
};

export const createIngredientSchema = z.object(ingredientFields);
export const updateIngredientSchema = z
  .object(ingredientFields)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "No hay cambios para guardar.");
export const listIngredientsQuery = z.object({ lowStock: queryBoolean });

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ProductInput = z.infer<typeof productInputSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuery>;
export type CreateIngredientInput = z.infer<typeof createIngredientSchema>;
export type UpdateIngredientInput = z.infer<typeof updateIngredientSchema>;
