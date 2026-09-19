// Migración de datos desde Supabase al VPS — docs/base-de-datos.md §9.
//
// Mueve usuarios, datos y archivos SIN transformar ids, para que las claves
// foráneas y los links que ya circulan sigan válidos.
//
//   npx tsx scripts/migrate-supabase.ts --dry-run
//   npx tsx scripts/migrate-supabase.ts
//   npx tsx scripts/migrate-supabase.ts --only=storage
//
// Variables:
//   SUPABASE_URL_DB    conexión a Postgres de Supabase (session pooler, 5432)
//   TARGET_URL_DB      conexión a la base del VPS con el rol dueño
//   SUPABASE_URL       https://<proyecto>.supabase.co   (solo para archivos)
//   SUPABASE_SERVICE_KEY  service_role key              (solo para archivos)
//   R2_*               las mismas que usa la API
//
// Seguridad: corta si la base destino ya tiene datos, salvo --force.
import type pg from "pg";
import { putObject, publicUrl } from "../src/lib/r2.js";
import {
  columnsOf,
  connect,
  countOf,
  IMAGE_COLUMNS,
  log,
  parseArgs,
  PUBLIC_TABLES,
  quote,
  requireEnv,
  warn
} from "./lib/migration.js";

const args = parseArgs(process.argv.slice(2));
const DRY_RUN = args.flags.has("dry-run");
const FORCE = args.flags.has("force");
const ONLY = args.values.get("only")?.split(",") ?? ["users", "data", "storage", "urls", "verify"];
const BATCH = 500;

const shouldRun = (step: string) => ONLY.includes(step);

// ── 1. Usuarios ──────────────────────────────────────────────────────────────

interface SupabaseUser {
  id: string;
  email: string;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
  raw_user_meta_data: unknown;
  last_sign_in_at: Date | null;
  created_at: Date;
}

/**
 * Supabase guarda bcrypt en `encrypted_password` con prefijo `$2a$`, que es el
 * mismo formato que lee nuestra auth: las contraseñas de los usuarios siguen
 * funcionando sin pedirles que las cambien.
 */
async function migrateUsers(source: pg.Client, target: pg.Client): Promise<void> {
  const { rows } = await source.query<SupabaseUser>(
    `select id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, last_sign_in_at, created_at
     from auth.users where deleted_at is null order by created_at`
  );
  log(`\n[usuarios] ${rows.length} en Supabase`);

  const sinPassword = rows.filter((u) => !u.encrypted_password);
  if (sinPassword.length) {
    warn(`${sinPassword.length} usuarios sin contraseña (entraron con OAuth o magic link).`);
    warn("Van a tener que usar 'Olvidé mi contraseña' la primera vez.");
  }

  if (DRY_RUN) return;

  for (const user of rows) {
    await target.query(
      `insert into auth.users (id, email, password_hash, email_verified_at, raw_user_meta_data, last_login_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do nothing`,
      [
        user.id,
        user.email,
        // Sin contraseña usable: un hash imposible de acertar. El usuario entra
        // con el flujo de reset, que además le verifica el email.
        user.encrypted_password ?? "$2a$12$" + "x".repeat(53),
        user.email_confirmed_at,
        user.raw_user_meta_data ?? {},
        user.last_sign_in_at,
        user.created_at
      ]
    );
  }
  log(`  ✓ ${rows.length} usuarios copiados`);
}

// ── 2. Datos ─────────────────────────────────────────────────────────────────

/** Copia tabla por tabla en orden de dependencias. */
async function migrateData(source: pg.Client, target: pg.Client): Promise<void> {
  log("\n[datos]");

  for (const table of PUBLIC_TABLES) {
    const total = await countOf(source, "public", table);
    if (total === 0) {
      log(`  ${table}: vacía`);
      continue;
    }

    // Solo las columnas que existen en las DOS bases: si Supabase tiene alguna
    // de más (deriva), se avisa en vez de romper a mitad de camino.
    const [sourceColumns, targetColumns] = await Promise.all([
      columnsOf(source, "public", table),
      columnsOf(target, "public", table)
    ]);
    const columns = sourceColumns.filter((c) => targetColumns.includes(c));
    const faltantes = sourceColumns.filter((c) => !targetColumns.includes(c));
    if (faltantes.length) warn(`${table}: columnas que no existen en el destino, se ignoran: ${faltantes.join(", ")}`);

    if (DRY_RUN) {
      log(`  ${table}: ${total} filas (dry-run)`);
      continue;
    }

    const columnList = columns.map(quote).join(", ");
    let copied = 0;
    for (let offset = 0; offset < total; offset += BATCH) {
      const { rows } = await source.query<Record<string, unknown>>(
        `select ${columnList} from public.${quote(table)} order by 1 limit $1 offset $2`,
        [BATCH, offset]
      );
      for (const row of rows) {
        const values = columns.map((c) => row[c]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        await target.query(
          `insert into public.${quote(table)} (${columnList}) values (${placeholders}) on conflict do nothing`,
          values
        );
      }
      copied += rows.length;
    }
    log(`  ✓ ${table}: ${copied}/${total}`);
  }
}

// ── 3. Archivos ──────────────────────────────────────────────────────────────

const BUCKET_TARGET: Record<string, "public" | "private"> = {
  "product-images": "public",
  "business-assets": "public",
  "payment-proofs": "private"
};

/**
 * Los archivos se listan desde `storage.objects` (la misma base) y se bajan por
 * la API de Supabase con la service key. La key se conserva tal cual: los
 * comprobantes ya guardan `storage_path` y no hace falta reescribir nada.
 */
async function migrateStorage(source: pg.Client): Promise<Map<string, string>> {
  log("\n[archivos]");
  const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = requireEnv("SUPABASE_SERVICE_KEY");
  const mapping = new Map<string, string>();

  for (const [bucket, kind] of Object.entries(BUCKET_TARGET)) {
    const { rows } = await source.query<{ name: string }>(
      `select name from storage.objects where bucket_id = $1 order by name`,
      [bucket]
    );
    log(`  ${bucket}: ${rows.length} archivos → ${kind === "public" ? "toki-public" : "toki-private"}`);
    if (DRY_RUN) continue;

    let ok = 0;
    for (const { name } of rows) {
      const url = `${supabaseUrl}/storage/v1/object/authenticated/${bucket}/${encodeURI(name)}`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } });
      if (!response.ok) {
        warn(`no se pudo bajar ${bucket}/${name} (${response.status})`);
        continue;
      }
      const body = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      await putObject(kind, name, body, contentType);
      if (kind === "public") {
        mapping.set(`${supabaseUrl}/storage/v1/object/public/${bucket}/${name}`, publicUrl(name));
      }
      ok++;
    }
    log(`  ✓ ${bucket}: ${ok}/${rows.length}`);
  }
  return mapping;
}

// ── 4. URLs ──────────────────────────────────────────────────────────────────

/**
 * Reescribe las URLs de imágenes del host de Supabase al de R2. Conserva las
 * keys, así que alcanza con cambiar el prefijo; los assets por defecto del
 * front (`/defaults/...`) no se tocan.
 */
async function rewriteUrls(target: pg.Client): Promise<void> {
  log("\n[urls de imágenes]");
  const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const prefixes = Object.keys(BUCKET_TARGET).map((bucket) => `${supabaseUrl}/storage/v1/object/public/${bucket}/`);
  const r2Base = publicUrl("").replace(/\/$/, "") + "/";

  for (const { table, column } of IMAGE_COLUMNS) {
    let total = 0;
    for (const prefix of prefixes) {
      if (DRY_RUN) {
        const { rows } = await target.query<{ n: string }>(
          `select count(*)::text as n from public.${quote(table)} where ${quote(column)} like $1`,
          [`${prefix}%`]
        );
        total += Number(rows[0]!.n);
        continue;
      }
      const result = await target.query(
        `update public.${quote(table)}
         set ${quote(column)} = $1 || substring(${quote(column)} from ${prefix.length + 1})
         where ${quote(column)} like $2`,
        [r2Base, `${prefix}%`]
      );
      total += result.rowCount ?? 0;
    }
    log(`  ${DRY_RUN ? "" : "✓ "}${table}.${column}: ${total}`);
  }

  if (DRY_RUN) return;
  // Lo que quedó apuntando a Supabase es una URL que no vamos a poder servir.
  for (const { table, column } of IMAGE_COLUMNS) {
    const { rows } = await target.query<{ n: string }>(
      `select count(*)::text as n from public.${quote(table)} where ${quote(column)} like '%supabase%'`
    );
    if (Number(rows[0]!.n) > 0) warn(`${table}.${column}: quedan ${rows[0]!.n} URLs de Supabase sin migrar`);
  }
}

// ── 5. Verificación ──────────────────────────────────────────────────────────

async function verify(source: pg.Client, target: pg.Client): Promise<boolean> {
  log("\n[verificación]");
  let ok = true;

  const usuariosOrigen = await countOf(source, "auth", "users");
  const usuariosDestino = await countOf(target, "auth", "users");
  const match = usuariosOrigen === usuariosDestino;
  if (!match) ok = false;
  log(`  ${match ? "✓" : "✗"} auth.users: ${usuariosOrigen} → ${usuariosDestino}`);

  for (const table of PUBLIC_TABLES) {
    const [a, b] = await Promise.all([countOf(source, "public", table), countOf(target, "public", table)]);
    if (a !== b) ok = false;
    if (a !== b || a > 0) log(`  ${a === b ? "✓" : "✗"} ${table}: ${a} → ${b}`);
  }

  // El total facturado es el número que el dueño del negocio va a mirar.
  const suma = async (client: pg.Client) => {
    const { rows } = await client.query<{ total: string | null }>(`select sum(total)::text as total from public.orders`);
    return rows[0]!.total ?? "0";
  };
  const [totalOrigen, totalDestino] = await Promise.all([suma(source), suma(target)]);
  const totalesIguales = Number(totalOrigen) === Number(totalDestino);
  if (!totalesIguales) ok = false;
  log(`  ${totalesIguales ? "✓" : "✗"} suma de orders.total: ${totalOrigen} → ${totalDestino}`);

  return ok;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const source = await connect(requireEnv("SUPABASE_URL_DB"), "Supabase");
  const target = await connect(requireEnv("TARGET_URL_DB"), "la base del VPS");

  log(DRY_RUN ? "Modo dry-run: no se escribe nada.\n" : "Migrando datos de Supabase al VPS.\n");

  try {
    const yaTieneDatos = await countOf(target, "public", "businesses");
    if (yaTieneDatos > 0 && !FORCE && !DRY_RUN) {
      throw new Error(
        `La base destino ya tiene ${yaTieneDatos} negocios. Si querés continuar igual, corré con --force.`
      );
    }

    // Triggers apagados durante TODA la copia. Si no: `handle_new_user` crea un
    // perfil por cada usuario insertado (y después el perfil real de Supabase
    // choca y se pierde), y `set_updated_at` pisa las fechas originales con hoy.
    if (!DRY_RUN) await target.query("set session_replication_role = replica");

    if (shouldRun("users")) await migrateUsers(source, target);
    if (shouldRun("data")) await migrateData(source, target);
    if (shouldRun("storage")) await migrateStorage(source);
    if (shouldRun("urls")) await rewriteUrls(target);

    if (!DRY_RUN) await target.query("set session_replication_role = origin");

    if (shouldRun("verify")) {
      const ok = await verify(source, target);
      log("");
      if (ok) {
        log("Todo cuadra. Siguiente paso: smoke test del front y del agente (docs/fases/fase7.md).");
      } else {
        log("Hay diferencias. NO hagas el corte hasta resolverlas.");
        process.exitCode = 1;
      }
    }
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
