// Migra la BD LOCAL de desarrollo. Uso: npm run db:migrate:deploy
//
// 1. Crea/actualiza el rol toki_app con la password de DATABASE_URL.
// 2. Aplica migraciones con el rol DUEÑO (DATABASE_URL_MIGRATE): toki_app no
//    tiene privilegios para crear tablas ni policies.
// 3. Le otorga a toki_app los roles de contexto.
import "dotenv/config";
import { applyMigrations, ensureAppRole, grantAppRole, passwordFromUrl } from "./lib/db-admin.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("migrate-dev no se usa en producción: el entrypoint aplica las migraciones.");
}

const ownerUrl = process.env.DATABASE_URL_MIGRATE;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl) throw new Error("Falta DATABASE_URL_MIGRATE en .env (rol dueño de la BD).");
if (!appUrl) throw new Error("Falta DATABASE_URL en .env (rol toki_app).");

await ensureAppRole(ownerUrl, passwordFromUrl(appUrl));
await applyMigrations(ownerUrl);
await grantAppRole(ownerUrl);
console.log("[migrate-dev] BD local al día.");
