// Acceso a datos — docs/arquitectura.md §5.
//
// La API se conecta como `toki_app` (NOINHERIT): sin SET ROLE no puede leer ni
// escribir nada. Cada operación corre en una transacción que adopta uno de los
// roles de contexto heredados de Supabase y carga los claims que lee auth.uid().
// Así las 60 policies RLS y las funciones SQL funcionan igual que en Supabase.
//
// REGLA: fuera de este archivo, health y scripts, prohibido usar getPrisma()
// directo. Todo service usa withDb.
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../config.js";

export type Tx = Prisma.TransactionClient;

export type DbCtx =
  | { role: "authenticated"; userId: string; email?: string | null }
  | { role: "anon" }
  | { role: "service_role" };

export type DbRole = DbCtx["role"];

// Allowlist fija: el nombre del rol va interpolado en SQL (SET no acepta
// parámetros), así que nunca puede venir de input.
const ROLE_SQL: Record<DbRole, string> = {
  anon: "anon",
  authenticated: "authenticated",
  service_role: "service_role"
};

const TX_TIMEOUT_MS = 15_000;

// Inicialización lazy: permite importar módulos (y correr tests sin BD) sin
// abrir conexiones. El primer uso real crea el pool.
let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  _prisma ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX })
  });
  return _prisma;
}

export async function disconnectDb(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

function claimsFor(ctx: DbCtx): Record<string, unknown> {
  if (ctx.role === "authenticated") {
    return { sub: ctx.userId, email: ctx.email ?? null, role: "authenticated" };
  }
  return { role: ctx.role };
}

/**
 * Ejecuta `fn` dentro de una transacción con el rol y los claims del contexto.
 * `set_config(..., true)` y `SET LOCAL` mueren con la transacción: no hay fuga
 * de contexto entre requests aunque el pool reutilice la conexión.
 */
export async function withDb<T>(ctx: DbCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getPrisma().$transaction(
    async (tx) => {
      await tx.$executeRaw`select set_config('request.jwt.claims', ${JSON.stringify(claimsFor(ctx))}, true)`;
      await tx.$executeRawUnsafe(`set local role ${ROLE_SQL[ctx.role]}`);
      return fn(tx);
    },
    { timeout: TX_TIMEOUT_MS, maxWait: 5_000 }
  );
}

export const anonCtx: DbCtx = { role: "anon" };
export const systemCtx: DbCtx = { role: "service_role" };
