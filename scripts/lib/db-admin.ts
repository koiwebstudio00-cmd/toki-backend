// Utilidades de administración de la BD para scripts locales (dev y test).
// NUNCA se usan en producción: ahí el rol lo crea scripts/bootstrap-prod.sql.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const APP_ROLE = "toki_app";

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Identificador inválido: ${name}`);
  return `"${name}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Crea (o actualiza la password de) toki_app. Los roles son de todo el cluster. */
export async function ensureAppRole(ownerUrl: string, password: string): Promise<void> {
  await withClient(ownerUrl, async (c) => {
    const { rowCount } = await c.query("select 1 from pg_roles where rolname = $1", [APP_ROLE]);
    const verb = rowCount ? "alter" : "create";
    await c.query(`${verb} role ${ident(APP_ROLE)} login noinherit password ${literal(password)}`);
  });
}

/** Otorga CONNECT y los roles de contexto (si ya existen: los crea la migración 0001). */
export async function grantAppRole(ownerUrl: string): Promise<void> {
  await withClient(ownerUrl, async (c) => {
    const db = (await c.query<{ db: string }>("select current_database() as db")).rows[0]!.db;
    await c.query(`grant connect on database ${ident(db)} to ${ident(APP_ROLE)}`);
    const { rowCount } = await c.query("select 1 from pg_roles where rolname = 'service_role'");
    if (rowCount) await c.query(`grant anon, authenticated, service_role to ${ident(APP_ROLE)}`);
  });
}

export function passwordFromUrl(url: string): string {
  const password = decodeURIComponent(new URL(url).password);
  if (!password) throw new Error("La URL de toki_app no tiene password.");
  return password;
}

/**
 * Aplica las migraciones pendientes.
 * - Por defecto: `prisma migrate deploy` (lo mismo que corre el entrypoint en producción).
 * - MIGRATE_WITH=sql: aplica los migration.sql con `pg` y registra cada uno en
 *   una tabla propia. Solo para entornos donde no se puede descargar el schema
 *   engine de Prisma (sandbox, CI sin red). No mezclar ambos modos en una misma BD.
 */
export async function applyMigrations(ownerUrl: string): Promise<void> {
  if (process.env.MIGRATE_WITH !== "sql") {
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: ownerUrl }
    });
    return;
  }

  const dir = join(process.cwd(), "prisma", "migrations");
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  await withClient(ownerUrl, async (c) => {
    await c.query(
      "create table if not exists public._sql_migrations (name text primary key, applied_at timestamptz not null default now())"
    );
    for (const name of names) {
      const { rowCount } = await c.query("select 1 from public._sql_migrations where name = $1", [name]);
      if (rowCount) continue;
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
      await c.query("begin");
      try {
        await c.query(sql);
        await c.query("insert into public._sql_migrations (name) values ($1)", [name]);
        await c.query("commit");
        console.log(`[migrate:sql] aplicada ${name}`);
      } catch (err) {
        await c.query("rollback");
        throw err;
      }
    }
  });
}
