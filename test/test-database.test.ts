import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { testDatabaseConfig } from "../scripts/lib/test-database.js";

const environment = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://toki_app:dev@localhost/toki",
  DATABASE_URL_MIGRATE: "postgresql://owner@localhost/toki",
  DATABASE_URL_TEST: "postgresql://owner@localhost/toki_test"
};

describe("configuración aislada de tests", () => {
  it("usa un rol exclusivo y conserva el destino y las opciones", () => {
    const config = testDatabaseConfig({ ...environment, DATABASE_URL_TEST: "postgresql://owner@localhost:5433/toki_test?sslmode=disable", DATABASE_TEST_APP_PASSWORD: "p@ss:word" });
    const runtime = new URL(config.runtimeUrl);
    expect(runtime.username).toBe("toki_test_app");
    expect(decodeURIComponent(runtime.password)).toBe("p@ss:word");
    expect(runtime.port).toBe("5433");
    expect(runtime.searchParams.get("sslmode")).toBe("disable");
    expect(config.ownerUrl).toContain("owner@");
  });

  it.each(["toki", "postgres", "bad%22_test", "bad%2F_test", "a".repeat(64) + "_test"])("rechaza nombres peligrosos: %s", name => {
    expect(() => testDatabaseConfig({ ...environment, DATABASE_URL_TEST: `postgresql://owner@localhost/${name}` })).toThrow();
  });

  it.each(["DATABASE_URL", "DATABASE_URL_MIGRATE", "DATABASE_URL_LISTEN"])("rechaza el destino de %s incluso con alias de host", key => {
    expect(() => testDatabaseConfig({ ...environment, [key]: "postgresql://owner@127.0.0.1/toki_test" })).toThrow(/no puede apuntar/);
  });

  it("rechaza producción, contraseña vacía y rol de tests usado en desarrollo", () => {
    expect(() => testDatabaseConfig({ ...environment, NODE_ENV: "production" })).toThrow(/producción/);
    expect(() => testDatabaseConfig({ ...environment, DATABASE_TEST_APP_PASSWORD: "" })).toThrow(/vacía/);
    expect(() => testDatabaseConfig({ ...environment, DATABASE_URL: "postgresql://toki_test_app:x@localhost/toki" })).toThrow(/reservado/);
  });

  it.each(["user=toki_app", "password=otra", "host=remote", "port=5433", "database=toki", "dbname=toki", "options=-c%20role%3Dservice_role"])("rechaza parámetros que sustituyen la conexión aislada: %s", query => {
    expect(() => testDatabaseConfig({ ...environment, DATABASE_URL_TEST: `${environment.DATABASE_URL_TEST}?${query}` })).toThrow(/parámetros/);
  });

  it("sin base de tests nunca conserva conexiones de desarrollo", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./test/setup.ts"); console.log(JSON.stringify([process.env.DATABASE_URL, process.env.DATABASE_URL_LISTEN]))'], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL_TEST: "", DATABASE_URL: "postgresql://dev@localhost/toki", DATABASE_URL_LISTEN: "postgresql://dev@localhost/toki" }
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(["postgresql://toki_test_app:x@127.0.0.1:1/none", "postgresql://toki_test_app:x@127.0.0.1:1/none"]);
  });
});
