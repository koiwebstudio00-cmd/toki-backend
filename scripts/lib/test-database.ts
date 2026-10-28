// Shared by preparation and Vitest: validate before opening any database connection.
export const TEST_APP_ROLE = "toki_test_app";

export function testDatabaseConfig(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV === "production") throw new Error("Las pruebas no se ejecutan en producción.");
  if (!env.DATABASE_URL_TEST) throw new Error("Falta DATABASE_URL_TEST en .env");
  const owner = new URL(env.DATABASE_URL_TEST);
  // pg accepts connection parameters in the query string. In particular,
  // ?user= overrides the username we assign to the isolated runtime URL.
  const overrides = new Set(["user", "password", "host", "hostaddr", "port", "database", "dbname", "options", "service"]);
  for (const key of owner.searchParams.keys()) {
    if (overrides.has(key.toLowerCase())) throw new Error("DATABASE_URL_TEST no admite parámetros que reemplacen el destino, rol o configuración de sesión.");
  }
  const database = decodeURIComponent(owner.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(owner.protocol) || !/^[a-z_][a-z0-9_]*_test$/.test(database) || database.length > 63) {
    throw new Error("La BD de test debe ser un identificador PostgreSQL válido terminado en _test.");
  }
  // Conservative comparison by name, including aliases such as localhost/127.0.0.1.
  for (const key of ["DATABASE_URL", "DATABASE_URL_MIGRATE", "DATABASE_URL_LISTEN"]) {
    if (!env[key]) continue;
    const development = new URL(env[key]);
    if (decodeURIComponent(development.pathname.slice(1)) === database) {
      throw new Error(`DATABASE_URL_TEST no puede apuntar a la base de ${key}.`);
    }
    if (decodeURIComponent(development.username) === TEST_APP_ROLE) {
      throw new Error(`${TEST_APP_ROLE} está reservado para tests; no puede usarse en ${key}.`);
    }
  }
  if (decodeURIComponent(owner.username) === TEST_APP_ROLE) throw new Error("DATABASE_URL_TEST requiere el rol dueño, no el rol de tests.");
  const password = env.DATABASE_TEST_APP_PASSWORD ?? "toki_app_test";
  if (!password) throw new Error("DATABASE_TEST_APP_PASSWORD no puede estar vacía.");
  const runtime = new URL(owner);
  runtime.username = TEST_APP_ROLE;
  runtime.password = password;
  return { ownerUrl: owner.toString(), runtimeUrl: runtime.toString(), database, password };
}
