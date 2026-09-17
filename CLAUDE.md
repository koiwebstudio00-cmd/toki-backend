# CLAUDE.md — toki-api

Backend REST multi-tenant de **Toki** (SaaS de pedidos para negocios gastronómicos). Reemplaza a Supabase como backend del front `toki-platform/toki`. Base: arquitectura de `clients/back-lamelas`, en producción desde julio 2026.

## Leer antes de codear

- `docs/descripcion.md`: qué es y qué módulos tiene
- `docs/arquitectura.md`: auth, contextos de BD, estructura, R2, realtime, deploy
- `docs/api.md`: contrato de endpoints (**la columna "Origen" dice qué llamada a Supabase reemplaza cada ruta**)
- `docs/base-de-datos.md`: tablas, funciones SQL, RLS, migraciones, migración de datos
- `docs/plan-implementacion.md`: fases y estado

## Stack

Node 22 · TypeScript (ESM) · Express 5 · Prisma 6.19 (`engineType = "client"` + `@prisma/adapter-pg`) · PostgreSQL 17 · Zod · JWT Bearer + refresh rotativo · bcrypt · Resend (nodemailer SMTP) · Cloudflare R2 · Vitest + supertest · Dokploy.

## Comandos

```bash
npm run dev                 # tsx watch
npm run db:migrate:deploy   # crea toki_app (dev) + aplica migraciones con DATABASE_URL_MIGRATE
npm run seed                # 2 negocios demo (owner@burger.test / toki12345)
npm run test:prepare        # recrea toki_test y aplica migraciones
npm test
npm run lint && npm run typecheck && npm run build
npm run db:migrate:create -- --name <nombre>   # SIEMPRE revisar el SQL generado
```

Sin red para el schema engine de Prisma (sandbox/CI): `MIGRATE_WITH=sql npm run test:prepare`.

## Reglas del proyecto

1. **RLS es la autorización.** Los middlewares (`requireBusiness`, `requireRole`) son fail-fast. Cambio de acceso = policy en migración + test de aislamiento con 2 negocios.
2. **Toda query va por `withDb(ctx, tx => ...)`** (`src/lib/db.ts`). Prohibido `getPrisma()` fuera de `lib/db.ts`, `health` y scripts.
3. **Contextos:** `authenticated` (panel, con userId) · `anon` (público) · `service_role` (auth, agente, checkout, sistema). `service_role` bypassa RLS: el service valida pertenencia al negocio antes de usarlo.
4. **La conexión es `toki_app` (NOINHERIT):** sin `SET ROLE` no lee nada. Si algo "necesita" más permisos, la policy o el contexto están mal elegidos.
5. **Cambios de BD = migración nueva** en `prisma/migrations/`, nunca editar una aplicada. Prisma no modela RLS, funciones, triggers, CHECK ni índices parciales: ese SQL va a mano en la migración. `migrate dev` sin `--create-only` está prohibido (borró defaults y citext en Lamelas).
6. **Funciones SQL existentes se reutilizan** (`persist_order`, `create_manual_sale`, `update_order_status`, `agent_*`...). **Lógica nueva va en TypeScript.**
7. **Estructura por módulo:** `routes.ts` (rutas + `schema.parse`) → `service.ts` (lógica) → `repo.ts` (queries). Sin lógica en routes, sin SQL en services.
8. **Validación con Zod** en body, params y query. Mensajes al usuario en español (AR), lenguaje simple para dueños de negocios de comida.
9. **Montos:** `Decimal` → `number` en el repo (`lib/money.ts`). Nunca devolver `Decimal`/`BigInt` en `res.json()`.
10. **Precios nunca del cliente.** Un único cálculo de pedidos (`orders/pricing.ts`) para web y WhatsApp.
11. **Secretos:** tokens solo hasheados en BD; nunca loguear tokens, contraseñas, API keys ni tickets. Emails fuera de transacciones.
12. **Código y columnas en inglés** (heredadas de Supabase). JSON de la API en camelCase.
13. **Contrato:** `/v1` no rompe. Si cambia una ruta, actualizar `docs/api.md`.

## Gotchas conocidos

- Errores de BD con driver adapter llegan como `PrismaClientKnownRequestError` (raw) **o** `DriverAdapterError` (escrituras). `mapDbError` cubre ambos: `P0001` → 400 con el mensaje de la función, `42501` (RLS) → 403, `23505` → 409.
- `updateMany` con RLS devuelve `count: 0` sin error cuando la fila es de otro negocio: traducir a 404.
- `anon` tiene GRANT sobre casi todas las tablas (herencia de Supabase): lo que protege es RLS, no el grant.
- Todo contexto que escribe necesita también policy de SELECT (Prisma relee la fila).
- `pg_dump` 16.10+ agrega líneas `\restrict`: son de psql y rompen `prisma migrate deploy`. No pegar dumps sin limpiarlos.

## Al terminar una tarea

`npm run lint && npm run typecheck && npm run build && npm test` sin errores. Modo de trabajo: Claude escribe en el repo; Cacho corre instalación, migraciones, tests y deploy en su Mac.
