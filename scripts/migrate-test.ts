// Recrea la BD de test desde cero y aplica migraciones. Uso: npm run test:prepare
//
// DATABASE_URL_TEST apunta a la BD de test con un rol dueño/superusuario
// (en la Mac: postgresql://dev0@localhost:5432/toki_test).
import "dotenv/config";
import { applyMigrations, ensureAppRole, grantAppRole, withClient } from "./lib/db-admin.js";

const TEST_APP_PASSWORD = "toki_app_test";

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) throw new Error("Falta DATABASE_URL_TEST en .env");

const url = new URL(testUrl);
const dbName = url.pathname.replace(/^\//, "");
if (!/_test$/.test(dbName)) {
  throw new Error(`Por seguridad la BD de test tiene que terminar en _test (recibido: ${dbName}).`);
}

const maintenance = new URL(testUrl);
maintenance.pathname = "/postgres";

await withClient(maintenance.toString(), async (c) => {
  await c.query(`drop database if exists "${dbName}" with (force)`);
  await c.query(`create database "${dbName}"`);
});
console.log(`[test:prepare] BD ${dbName} recreada.`);

await ensureAppRole(testUrl, TEST_APP_PASSWORD);
await applyMigrations(testUrl);
await grantAppRole(testUrl);
console.log("[test:prepare] Migraciones aplicadas. Listo para npm test.");
