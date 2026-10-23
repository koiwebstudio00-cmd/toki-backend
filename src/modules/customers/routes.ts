import { z } from "zod";
import * as transfer from "./transfer.js";
import { Router } from "express";
import { businessScope } from "../../lib/request.js";
import { idParams } from "../../lib/validation.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusiness } from "../../middleware/business.js";
import { listCustomersQuery, updateCustomerBody } from "./schemas.js";
import * as svc from "./service.js";

/** /v1/customers */
export const customerRoutes = Router();

customerRoutes.use(requireAuth, requireBusiness);

customerRoutes.get("/", async (req, res) => {
  res.json(await svc.list(businessScope(req), listCustomersQuery.parse(req.query)));
});

customerRoutes.post("/", async (req,res) => { res.status(201).json(await transfer.create(businessScope(req),transfer.createBody.parse(req.body))); });
customerRoutes.get("/transfer", async (req,res) => { res.json(await transfer.exportPage(businessScope(req),z.coerce.number().int().min(1).default(1).parse(req.query.page))); });
customerRoutes.post("/import", async (req,res) => { const body=transfer.rowsBody.parse(req.body); res.json(await transfer.importRows(businessScope(req),body.rows,body.preview)); });
customerRoutes.get("/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.get(businessScope(req), id));
});

customerRoutes.patch("/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await svc.update(businessScope(req), id, updateCustomerBody.parse(req.body)));
});
