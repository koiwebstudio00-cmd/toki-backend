import { Router } from "express";
import { businessScope } from "../../lib/request.js";
import { idParams } from "../../lib/validation.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireAdmin, requireBusiness } from "../../middleware/business.js";
import * as categories from "./categories.service.js";
import * as ingredients from "./ingredients.service.js";
import * as products from "./products.service.js";
import {
  availabilitySchema,
  createCategorySchema,
  createIngredientSchema,
  listCategoriesQuery,
  listIngredientsQuery,
  listProductsQuery,
  productInputSchema,
  reorderCategoriesSchema,
  stockSchema,
  updateCategorySchema,
  updateIngredientSchema
} from "./schemas.js";

// ── /v1/categories ──────────────────────────────────────────────────────────

export const categoryRoutes = Router();
categoryRoutes.use(requireAuth, requireBusiness);

categoryRoutes.get("/", async (req, res) => {
  const { active } = listCategoriesQuery.parse(req.query);
  res.json({ data: await categories.list(businessScope(req), active) });
});

categoryRoutes.post("/", requireAdmin, async (req, res) => {
  res.status(201).json(await categories.create(businessScope(req), createCategorySchema.parse(req.body)));
});

// Antes que /:id para que "reorder" no se tome como id.
categoryRoutes.patch("/reorder", requireAdmin, async (req, res) => {
  const { ids } = reorderCategoriesSchema.parse(req.body);
  res.json({ data: await categories.reorder(businessScope(req), ids) });
});

categoryRoutes.patch("/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await categories.update(businessScope(req), id, updateCategorySchema.parse(req.body)));
});

categoryRoutes.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  await categories.remove(businessScope(req), id);
  res.status(204).end();
});

// ── /v1/products ────────────────────────────────────────────────────────────

export const productRoutes = Router();
productRoutes.use(requireAuth, requireBusiness);

productRoutes.get("/", async (req, res) => {
  res.json({ data: await products.list(businessScope(req), listProductsQuery.parse(req.query)) });
});

productRoutes.get("/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await products.get(businessScope(req), id));
});

productRoutes.post("/", requireAdmin, async (req, res) => {
  res.status(201).json(await products.create(businessScope(req), productInputSchema.parse(req.body)));
});

productRoutes.put("/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await products.replace(businessScope(req), id, productInputSchema.parse(req.body)));
});

productRoutes.patch("/:id/availability", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { isAvailable } = availabilitySchema.parse(req.body);
  res.json(await products.setAvailability(businessScope(req), id, isAvailable));
});

productRoutes.patch("/:id/stock", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { stockQuantity, trackStock } = stockSchema.parse(req.body);
  res.json(await products.setStock(businessScope(req), id, stockQuantity, trackStock));
});

productRoutes.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  await products.remove(businessScope(req), id);
  res.status(204).end();
});

// ── /v1/ingredients ─────────────────────────────────────────────────────────

export const ingredientRoutes = Router();
ingredientRoutes.use(requireAuth, requireBusiness);

ingredientRoutes.get("/", async (req, res) => {
  const { lowStock } = listIngredientsQuery.parse(req.query);
  res.json({ data: await ingredients.list(businessScope(req), lowStock) });
});

ingredientRoutes.post("/", requireAdmin, async (req, res) => {
  res.status(201).json(await ingredients.create(businessScope(req), createIngredientSchema.parse(req.body)));
});

ingredientRoutes.patch("/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await ingredients.update(businessScope(req), id, updateIngredientSchema.parse(req.body)));
});

ingredientRoutes.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = idParams.parse(req.params);
  await ingredients.remove(businessScope(req), id);
  res.status(204).end();
});
