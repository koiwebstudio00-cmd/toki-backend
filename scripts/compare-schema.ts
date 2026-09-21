// Compara el schema real de Supabase con la réplica del VPS.
//
// Es el PRIMER paso de la fase 7 (hallazgo H1 en docs/base-de-datos.md): el
// repo de migraciones de Supabase tenía deriva con lo que estaba aplicado de
// verdad, así que antes de mover un solo dato hay que confirmar que las dos
// bases tienen el mismo schema.
//
//   SUPABASE_URL_DB=postgresql://... TARGET_URL_DB=postgresql://... \
//     npx tsx scripts/compare-schema.ts
//
// No escribe nada: compara y lista las diferencias.
import type pg from "pg";
import { connect, log, requireEnv } from "./lib/migration.js";

interface Row {
  key: string;
}

/** Cada consulta devuelve una lista de "firmas" comparables entre bases. */
const QUERIES: { label: string; sql: string }[] = [
  {
    label: "columnas",
    sql: `select table_name || '.' || column_name || ' ' || data_type
                 || coalesce(' (' || character_maximum_length || ')', '')
                 || case when is_nullable = 'YES' then ' null' else ' not null' end as key
          from information_schema.columns
          where table_schema = 'public' and table_name <> '_sql_migrations'
          order by 1`
  },
  {
    label: "defaults",
    sql: `select table_name || '.' || column_name || ' = ' || column_default as key
          from information_schema.columns
          where table_schema = 'public' and column_default is not null and table_name <> '_sql_migrations'
          order by 1`
  },
  {
    label: "constraints",
    sql: `select conrelid::regclass::text || ': ' || conname || ' ' || pg_get_constraintdef(oid) as key
          from pg_constraint
          where connamespace = 'public'::regnamespace
          order by 1`
  },
  {
    label: "índices",
    sql: `select indexdef as key from pg_indexes
          where schemaname = 'public' and tablename <> '_sql_migrations'
          order by 1`
  },
  {
    label: "policies RLS",
    sql: `select tablename || ': ' || policyname || ' [' || array_to_string(roles, ',') || '] ' || cmd
                 || ' using(' || coalesce(qual, '-') || ') check(' || coalesce(with_check, '-') || ')' as key
          from pg_policies where schemaname = 'public'
          order by 1`
  },
  {
    label: "RLS habilitado",
    sql: `select c.relname || ' rls=' || c.relrowsecurity as key
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '_sql_migrations'
          order by 1`
  },
  {
    label: "funciones",
    sql: `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private')
          order by 1`
  },
  {
    label: "cuerpo de funciones",
    sql: `select p.proname || ' :: ' || md5(pg_get_functiondef(p.oid)) as key
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private') and p.prokind = 'f'
          order by 1`
  },
  {
    label: "triggers",
    sql: `select c.relname || ': ' || t.tgname as key
          from pg_trigger t join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not t.tgisinternal
          order by 1`
  },
  {
    label: "enums",
    sql: `select t.typname || ' = ' || string_agg(e.enumlabel, ',' order by e.enumsortorder) as key
          from pg_type t join pg_enum e on e.enumtypid = t.oid
          join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public'
          group by t.typname order by 1`
  }
];

async function keys(client: pg.Client, sql: string): Promise<Set<string>> {
  const { rows } = await client.query<Row>(sql);
  return new Set(rows.map((r) => r.key));
}

async function main(): Promise<void> {
  const source = await connect(requireEnv("SUPABASE_URL_DB"), "Supabase");
  const target = await connect(requireEnv("TARGET_URL_DB"), "la base del VPS");

  let differences = 0;

  try {
    for (const { label, sql } of QUERIES) {
      const [a, b] = await Promise.all([keys(source, sql), keys(target, sql)]);
      const soloSupabase = [...a].filter((k) => !b.has(k));
      const soloReplica = [...b].filter((k) => !a.has(k));

      if (soloSupabase.length === 0 && soloReplica.length === 0) {
        log(`✓ ${label}: idénticos (${a.size})`);
        continue;
      }
      differences += soloSupabase.length + soloReplica.length;
      log(`\n✗ ${label}: ${soloSupabase.length} solo en Supabase, ${soloReplica.length} solo en la réplica`);
      // El cuerpo de las funciones se compara por hash: mostrar el md5 no
      // ayuda, alcanza con el nombre para ir a mirarla.
      for (const key of soloSupabase.slice(0, 25)) log(`    solo Supabase: ${key}`);
      for (const key of soloReplica.slice(0, 25)) log(`    solo réplica:  ${key}`);
      if (soloSupabase.length + soloReplica.length > 50) log("    ... (recortado)");
    }

    log("");
    if (differences === 0) {
      log("Las dos bases tienen el mismo schema. Se puede migrar.");
    } else {
      log(`Hay ${differences} diferencias. Resolvelas con una migración nueva ANTES de mover datos.`);
      log("Las diferencias en 'cuerpo de funciones' suelen ser inocuas (formato del dump):");
      log("comparalas con `\\sf nombre_funcion` en las dos bases antes de tocar nada.");
      process.exitCode = 1;
    }
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
