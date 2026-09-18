// Infraestructura: cosas que, si se rompen, se rompen en producción y no en
// la compu de nadie. No necesitan base de datos.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("configuración de producción", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  function prodEnv(overrides: Record<string, string | undefined>) {
    process.env = {
      ...original,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://toki_app:x@toki-db:5432/toki",
      JWT_SECRET: "a".repeat(64),
      CORS_ORIGIN: "https://app.toki.ar",
      AGENT_API_KEY_SHA256: "b".repeat(64),
      ...overrides
    } as NodeJS.ProcessEnv;
  }

  it("arranca con la configuración completa", async () => {
    prodEnv({});
    const { config } = await import("../src/config.js");
    expect(config.NODE_ENV).toBe("production");
  });

  it("no arranca sin DATABASE_URL", async () => {
    prodEnv({ DATABASE_URL: undefined });
    await expect(import("../src/config.js")).rejects.toThrow();
  });

  it("no arranca con un JWT_SECRET corto: mejor no arrancar que arrancar inseguro", async () => {
    prodEnv({ JWT_SECRET: "corto" });
    await expect(import("../src/config.js")).rejects.toThrow(/JWT_SECRET/);
  });

  it("no arranca sin allowlist de CORS", async () => {
    prodEnv({ CORS_ORIGIN: "" });
    await expect(import("../src/config.js")).rejects.toThrow(/CORS_ORIGIN/);
  });

  it("no arranca si la API key del agente no es un sha256", async () => {
    prodEnv({ AGENT_API_KEY_SHA256: "esto-no-es-un-hash" });
    await expect(import("../src/config.js")).rejects.toThrow(/AGENT_API_KEY_SHA256/);
  });

  it("en desarrollo arranca sin secretos", async () => {
    process.env = { ...original, NODE_ENV: "development", DATABASE_URL: "postgresql://x@localhost/y" };
    const { config } = await import("../src/config.js");
    expect(config.NODE_ENV).toBe("development");
  });
});

describe("archivos de deploy", () => {
  it("los scripts de shell no tienen errores de sintaxis", () => {
    for (const script of ["scripts/backup-to-r2.sh", "scripts/restore-from-r2.sh", "scripts/smoke.sh", "docker-entrypoint.sh"]) {
      expect(() => execFileSync("sh", ["-n", script], { cwd: new URL("..", import.meta.url) })).not.toThrow();
    }
  });

  it("la base no expone puerto al host", () => {
    const compose = read("docker-compose.yml");
    const dbBlock = compose.slice(compose.indexOf("toki-db:"), compose.indexOf("toki-api:"));
    expect(dbBlock).not.toMatch(/^\s+ports:/m);
    expect(dbBlock).toMatch(/healthcheck:/);
  });

  it("el compose exige los secretos en vez de inventar un default", () => {
    const compose = read("docker-compose.yml");
    for (const required of ["JWT_SECRET", "AGENT_API_KEY_SHA256", "DATABASE_URL", "CORS_ORIGIN", "POSTGRES_PASSWORD"]) {
      expect(compose).toMatch(new RegExp(`\\$\\{${required}:\\?`));
    }
  });

  it("la imagen no corre como root y tiene healthcheck", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/HEALTHCHECK/);
  });

  it("el ejemplo de producción no trae secretos de verdad", () => {
    const env = read(".env.production.example");
    // Todo valor sensible tiene que estar como <placeholder>.
    for (const key of ["JWT_SECRET", "AGENT_API_KEY_SHA256", "SMTP_PASS", "R2_SECRET_ACCESS_KEY", "ZERNIO_API_KEY"]) {
      const line = env.split("\n").find((l) => l.startsWith(`${key}=`));
      expect(line, `falta ${key}`).toBeTruthy();
      expect(line).toMatch(/=<.*>$/);
    }
  });

  it("el .env real está ignorado por git", () => {
    const ignore = read(".gitignore");
    expect(ignore).toMatch(/^\.env$/m);
  });
});
