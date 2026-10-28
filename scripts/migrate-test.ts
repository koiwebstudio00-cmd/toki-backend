// Recrea la BD de test desde cero y aplica migraciones. Uso: npm run test:prepare
//
// DATABASE_URL_TEST apunta a la BD de test con un rol dueño/superusuario
// (en la Mac: postgresql://dev0@localhost:5432/toki_test).
import "dotenv/config";
import { applyMigrations, ensureAppRole, grantAppRole, withClient } from "./lib/db-admin.js";
import { testDatabaseConfig, TEST_APP_ROLE } from "./lib/test-database.js";

const { ownerUrl: testUrl, runtimeUrl, database: dbName, password } = testDatabaseConfig(process.env);

const maintenance = new URL(testUrl);
maintenance.pathname = "/postgres";

await ensureAppRole(maintenance.toString(), password, TEST_APP_ROLE, true);
// Check existing credentials BEFORE dropping the test database. No password reset.
const probe = new URL(runtimeUrl);
probe.pathname = "/postgres";
try {
  await withClient(probe.toString(), async (c) => { await c.query("select 1"); });
} catch {
  throw new Error("No se pudo conectar con toki_test_app. Revisá DATABASE_TEST_APP_PASSWORD y el acceso a postgres; no se recreó la BD ni se cambió la contraseña existente.");
}

await withClient(maintenance.toString(), async (c) => {
  await c.query(`drop database if exists "${dbName}" with (force)`);
  await c.query(`create database "${dbName}"`);
});
console.log(`[test:prepare] BD ${dbName} recreada.`);

await applyMigrations(testUrl);
await grantAppRole(testUrl, TEST_APP_ROLE);
console.log("[test:prepare] Migraciones aplicadas. Listo para npm test.");
