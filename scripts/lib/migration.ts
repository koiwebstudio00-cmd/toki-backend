// Piezas compartidas por los scripts de migración desde Supabase.
import pg from "pg";

/**
 * Orden de copia: una tabla va después de todo aquello a lo que apunta.
 * `profiles` va justo después de los usuarios (su FK es a auth.users).
 */
export const PUBLIC_TABLES = [
  "businesses",
  "profiles",
  "business_members",
  "business_hours",
  "business_special_hours",
  "payment_settings",
  "loyalty_settings",
  "bot_settings",
  "bot_faqs",
  "categories",
  "products",
  "product_options",
  "product_option_values",
  "inventory_ingredients",
  "coupons",
  "customers",
  "customer_addresses",
  "whatsapp_integrations",
  "whatsapp_conversations",
  "whatsapp_messages",
  "orders",
  "order_items",
  "order_item_options",
  "order_status_history",
  "payments",
  "order_payment_proofs",
  "whatsapp_order_drafts",
  "whatsapp_order_draft_items"
] as const;

export type PublicTable = (typeof PUBLIC_TABLES)[number];

/** Columnas de imagen que guardan una URL del storage de Supabase. */
export const IMAGE_COLUMNS: { table: string; column: string }[] = [
  { table: "businesses", column: "logo_url" },
  { table: "businesses", column: "cover_url" },
  { table: "categories", column: "image_url" },
  { table: "products", column: "image_url" }
];

export interface Args {
  flags: Set<string>;
  values: Map<string, string>;
}

export function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    if (value === undefined) flags.add(key!);
    else values.set(key!, value);
  }
  return { flags, values };
}

export async function connect(url: string, label: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, statement_timeout: 300_000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`No se pudo conectar a ${label}: ${err instanceof Error ? err.message : err}`);
  }
  return client;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} en el entorno.`);
  return value;
}

/** Columnas reales de una tabla, en orden. */
export async function columnsOf(client: pg.Client, schema: string, table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [schema, table]
  );
  return rows.map((r) => r.column_name);
}

export async function countOf(client: pg.Client, schema: string, table: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from ${schema}.${quote(table)}`);
  return Number(rows[0]!.n);
}

export function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`Identificador inválido: ${identifier}`);
  return `"${identifier}"`;
}

export const log = (message: string) => console.log(message);
export const warn = (message: string) => console.warn(`  ⚠ ${message}`);
