import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DB_AVAILABLE } from "./helpers.js";

describe("GET /v1/health", () => {
  it.runIf(DB_AVAILABLE)("responde ok con la BD arriba, conectado como toki_app", async () => {
    const res = await request(buildApp()).get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: "up" });
    expect(res.body).toHaveProperty("version");
  });

  it("devuelve 404 con formato uniforme para rutas inexistentes", async () => {
    const res = await request(buildApp()).get("/v1/no-existe");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rechaza JSON mal formado con 400", async () => {
    const res = await request(buildApp())
      .post("/v1/no-existe")
      .set("content-type", "application/json")
      .send("{mal");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
