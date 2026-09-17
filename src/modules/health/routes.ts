import { Router } from "express";
import { config } from "../../config.js";
import { getPrisma } from "../../lib/db.js";

export const healthRoutes = Router();

// Única ruta que usa el cliente sin contexto: `select 1` no toca tablas, así que
// toki_app puede ejecutarlo sin SET ROLE.
healthRoutes.get("/health", async (_req, res) => {
  let db: "up" | "down" = "down";
  try {
    await Promise.race([
      getPrisma().$queryRaw`select 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000))
    ]);
    db = "up";
  } catch {
    // BD caída: el endpoint responde igual para el monitoreo.
  }
  res.status(db === "up" ? 200 : 503).json({ ok: db === "up", db, version: config.APP_VERSION });
});
