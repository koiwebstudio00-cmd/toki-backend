# Toki API — Arquitectura

**Fecha:** 2026-09-17 · **Versión:** 1.0 · **Base:** arquitectura de `back-lamelas` (en producción desde 2026-07-28), adaptada a Toki.

---

## 1. Visión

API REST multi-tenant en Express, desplegada con Dokploy en un VPS junto a su PostgreSQL 17. El front (SPA en Vercel) y el agente de WhatsApp (n8n) son sus clientes. Las fotos van directo del navegador a R2 y los emails salen por Resend.

**Principios:**

1. **RLS es la autorización.** Las 60 policies heredadas de Supabase se conservan; la API corre cada query dentro de un contexto de rol.
2. **Una sola fuente de verdad para la lógica sensible:** el cálculo de pedidos (`orderPricing` + `persist_order`) es el mismo para la web y para WhatsApp.
3. **La lógica SQL existente se reutiliza**, y la lógica nueva se escribe en TypeScript. No se agregan funciones plpgsql salvo que haga falta atomicidad o que las use una policy.
4. **Reutilizar back-lamelas** en todo lo que no sea dominio: config, errores, mailer, R2, Zernio, Docker y tests.

## 2. Topología

```text
                         ┌────────────────────── VPS (Dokploy) ──────────────────────┐
Navegador (SPA Vercel) ──┤ Traefik :443 ──► toki-api :3000 ──(red privada)──► toki-db │
  │  Bearer JWT          │                     │  ▲                         postgres:17 │
  │                      │                     │  └── LISTEN toki_orders ◄── NOTIFY    │
  │                      └─────────────────────┼───────────────────────────────────────┘
  │                                            │
  ├── PUT/GET prefirmado ──────────────────────┼──► Cloudflare R2 (toki-public / toki-private)
  └── EventSource (SSE) ◄── /v1/orders/events ─┘
                                               ├──► Resend (SMTP)          emails
                                               ├──► Zernio API             conexión de WhatsApp
Zernio ──webhook──► n8n ──X-Api-Key──► /v1/agent/*
Dokploy ──backup diario──► R2 (toki-backups)
```

- **Postgres no se expone a internet.** Para tareas puntuales (migración de datos) se usa un túnel SSH, no un puerto público.
- **Las fotos no pasan por Node:** la API solo firma URLs.
- **n8n sigue orquestando el agente.** El backend le da tools seguras y deterministas.

## 3. Ciclo de vida de un request

```text
request
 → requestLogger (morgan)
 → helmet · cors (allowlist) · express.json (1 MB)
 → router /v1/<módulo>
     → rateLimit (auth y public)
     → auth: requireAuth (Bearer) | requireApiKey (agent) | nada (public)
     → requireBusiness: resuelve negocio y rol del usuario (fail-fast de rol)
     → validate(zod): body / params / query
     → service
         → withDb(ctx, tx => repo...)   ← transacción con rol + claims (RLS)
 → res.json(...)
 → errorHandler: ZodError / ApiError / Prisma → { error: { code, message, details } }
```

## 4. Autenticación

### 4.1 Usuarios del panel (Bearer + refresh rotativo)

| Pieza | Diseño |
| --- | --- |
| Registro | `POST /auth/register` → `auth.users` (bcrypt, costo 12) → el trigger `handle_new_user` crea `profiles` → email de verificación (token opaco, 24 h) |
| Login | Solo con email verificado. Devuelve `accessToken` (JWT HS256, 15 min, claims `sub`, `email`) + `refreshToken` (opaco, 30 días) |
| Refresh | Rota el token: el usado se revoca y apunta al nuevo (`replaced_by`). **Reutilizar un token revocado revoca toda la cadena** (detección de robo) |
| Logout | Revoca el refresh actual, o todos con `{ all: true }` |
| Reset | Token opaco de 1 h; al usarse revoca todas las sesiones |
| Almacenamiento en BD | Solo hashes SHA-256 (`auth.refresh_tokens`, `auth.email_tokens`). Nunca se loguean tokens ni contraseñas |
| En el front | `accessToken` en memoria y `refreshToken` en `localStorage`, igual que `supabase-js` hoy. Header `Authorization: Bearer` |

**Por qué Bearer y no cookies como Lamelas:** el front de Toki es una SPA en otro dominio (Vercel). Con cookies cross-site, Safari bloquea la sesión. En Lamelas no pasa porque el panel es un BFF de Next. Si más adelante front y API comparten dominio (`app.` y `api.`), el refresh token puede pasar a una cookie httpOnly sin cambiar el resto.

### 4.2 Negocio actual y rol

- `requireBusiness` lee `business_members` del usuario. El negocio se toma del header opcional `X-Business-Id`; si no viene, del primero (el front hoy usa uno solo).
- Deja `req.ctx = { userId, email, businessId, role }`. `requireRole("owner", "admin")` corta con 403 antes de tocar la base, pero **la garantía la da RLS**.

### 4.3 Agente de n8n

- Header `X-Api-Key`. La key se guarda **hasheada** en env (`AGENT_API_KEY_SHA256`) y se compara en tiempo constante.
- El `business_id` **no** viene de la key: las tools reciben `businessId` y `conversationId`, y cada función SQL valida que la conversación pertenezca al negocio (así funcionan las RPC `agent_*`).
- Contexto de BD: `service_role`.

### 4.4 Público

Sin sesión. Contexto de BD `anon` (las policies públicas solo muestran negocios activos y catálogo disponible). El checkout usa `service_role` porque `persist_order` solo lo ejecuta ese rol, igual que la Edge Function actual.

## 5. Acceso a datos y RLS

### 5.1 Roles de Postgres

| Rol | Tipo | Uso |
| --- | --- | --- |
| `toki_owner` | LOGIN, dueño del schema | Solo migraciones (`DATABASE_URL_MIGRATE`) |
| `toki_app` | LOGIN, `NOINHERIT`, sin privilegios propios | Conexión de la API (`DATABASE_URL`) |
| `anon` | NOLOGIN | Contexto público |
| `authenticated` | NOLOGIN | Contexto de usuario del panel |
| `service_role` | NOLOGIN, `BYPASSRLS` | Contexto de sistema: auth, agente, checkout, jobs |

`toki_app` es miembro de los tres roles de contexto, pero por `NOINHERIT` **no puede leer nada hasta hacer `SET ROLE`**. Verificado: sin `SET ROLE`, `select from orders` da *permission denied*.

Los roles conservan los nombres de Supabase a propósito: así las policies, los `GRANT` y las funciones de la réplica funcionan sin reescribirse.

### 5.2 `withDb`: única puerta a la base

```ts
// src/lib/db.ts
export type DbCtx =
  | { role: "authenticated"; userId: string; email?: string }
  | { role: "anon" }
  | { role: "service_role" };

export async function withDb<T>(ctx: DbCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getPrisma().$transaction(async (tx) => {
    const claims = ctx.role === "authenticated"
      ? { sub: ctx.userId, email: ctx.email ?? null, role: "authenticated" }
      : { role: ctx.role };
    await tx.$executeRaw`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx.$executeRawUnsafe(`set local role ${ROLE_SQL[ctx.role]}`); // allowlist fija
    return fn(tx);
  }, { timeout: 15_000 });
}
```

- `auth.uid()` lee `request.jwt.claims`, así que `create_business_with_owner`, `update_order_status`, `mark_order_paid` y `create_manual_sale` funcionan igual que desde Supabase.
- **Regla del repo:** prohibido usar `getPrisma()` fuera de `lib/db.ts`, `health` y los scripts. Todo service usa `withDb`.
- `set_config(..., true)` y `SET LOCAL` mueren con la transacción: no hay fuga de contexto entre requests.

### 5.3 Cuándo SQL y cuándo Prisma

| Caso | Cómo |
| --- | --- |
| Lógica ya existente en SQL (`persist_order`, `create_manual_sale`, `update_order_status`, `mark_order_paid`, `get_public_order`, `search_dashboard`, `business_is_open`, `agent_*`) | `tx.$queryRaw` tipado en el `repo.ts` |
| CRUD simple | Cliente de Prisma dentro de `withDb` |
| Lógica nueva | TypeScript en el service |
| Cambios de schema | Migración SQL revisada (ver `base-de-datos.md` §7) |

**Gotchas heredados de Lamelas:**

- `Decimal` y `BigInt` no pasan por `res.json()`: los montos se convierten a `number` en el repo.
- `updateMany` con RLS devuelve 0 filas en vez de fallar: se traduce a 404.
- Todo contexto que escribe también necesita policy de SELECT.

## 6. Estructura del repo

```text
toki-api/
├── src/
│   ├── app.ts                  # Express: middlewares globales + montaje de routers
│   ├── server.ts               # listen + arranque del hub de realtime
│   ├── config.ts               # env con Zod; falla si faltan secretos en prod
│   ├── middleware/
│   │   ├── auth.ts             # requireAuth (Bearer JWT)
│   │   ├── business.ts         # requireBusiness, requireRole
│   │   ├── apiKey.ts           # requireApiKey (agente)
│   │   ├── rateLimit.ts
│   │   ├── validate.ts         # helper Zod para body/params/query
│   │   ├── logging.ts          # morgan
│   │   └── error.ts            # notFound + errorHandler
│   ├── lib/
│   │   ├── db.ts               # Prisma + withDb
│   │   ├── errors.ts           # ApiError y códigos
│   │   ├── tokens.ts           # JWT, tokens opacos, sha256
│   │   ├── passwords.ts        # bcrypt
│   │   ├── mailer.ts           # nodemailer → Resend
│   │   ├── email-templates/    # verify-email, reset-password (HTML + texto)
│   │   ├── r2.ts               # presign PUT/GET, delete, keys por negocio
│   │   ├── zernio.ts           # cliente HTTP de Zernio
│   │   ├── realtime.ts         # LISTEN toki_orders + hub SSE por negocio
│   │   ├── money.ts            # Decimal → number
│   │   └── order-code.ts       # TK-XXXXXX único
│   ├── modules/
│   │   └── <módulo>/           # health, auth, account, businesses, settings, coupons,
│   │       ├── routes.ts       # catalog, uploads, orders, customers, dashboard,
│   │       ├── schemas.ts      # whatsapp, public, agent
│   │       ├── service.ts
│   │       └── repo.ts
│   └── types/express.d.ts      # req.ctx
├── prisma/
│   ├── schema.prisma           # espejo de la réplica (multiSchema auth + public)
│   ├── migrations/
│   │   ├── 0001_baseline_supabase/
│   │   ├── 0002_auth_sessions/
│   │   └── 0003_realtime_notify/
│   └── seed.ts
├── scripts/
│   ├── bootstrap-prod.sql      # roles toki_app con password fuerte (antes del 1er deploy)
│   ├── migrate-dev.ts · migrate-test.ts
│   ├── migrate-supabase.ts     # datos + archivos Supabase → VPS/R2
│   └── admin-cli.ts
├── test/                       # vitest + supertest; RLS con 2 negocios
├── docs/
├── Dockerfile · docker-entrypoint.sh · .env.example
└── package.json · tsconfig.json · eslint.config.mjs · vitest.config.ts
```

**Convención por módulo:**

- `routes.ts`: rutas y middlewares, sin lógica.
- `schemas.ts`: Zod, fuente de los tipos de entrada.
- `service.ts`: reglas de negocio y orquestación.
- `repo.ts`: la única capa con queries.

Código en inglés; columnas de BD en inglés (heredadas); mensajes al usuario en español (AR).

## 7. Archivos (R2)

| Bucket | Acceso | Keys |
| --- | --- | --- |
| `toki-public` | Lectura pública (dominio propio o `r2.dev`) | `<business_id>/products/<uuid>.webp` · `<business_id>/categories/<uuid>.webp` · `<business_id>/business/logo-<uuid>.webp` · `<business_id>/business/cover-<uuid>.webp` |
| `toki-private` | Solo URL firmada (GET, 10 min) | `<business_id>/payment-proofs/<order_code>/<uuid>.<ext>` |
| `toki-backups` | Solo Dokploy | Dumps diarios |

**Flujo de imagen:**

1. `POST /v1/uploads/presign { kind }`: valida rol y devuelve `{ uploadUrl, key, publicUrl }`.
2. El navegador comprime a WebP y hace `PUT` directo a R2.
3. El front guarda `publicUrl` en el producto, la categoría o el negocio.
4. Al reemplazar o borrar, el service elimina el objeto anterior (sin frenar el flujo si falla).

**Gotchas ya resueltos en Lamelas:**

- CORS del bucket como **array** de orígenes, con `PUT` y `content-type`.
- Checksum del SDK en `WHEN_REQUIRED`.
- Un token de R2 por bucket.

## 8. Tiempo real (reemplazo de Supabase Realtime)

```text
INSERT/UPDATE/DELETE orders ──trigger──► pg_notify('toki_orders', {business_id, order_id, op})
toki-api: 1 conexión pg dedicada ── LISTEN toki_orders ──► hub.emit(business_id)
GET /v1/orders/events?ticket=... ──SSE──► dashboards de ese negocio
```

- **Ticket:** `EventSource` no puede mandar `Authorization`. El front pide `POST /v1/orders/events/ticket` (Bearer) y recibe un ticket de un solo uso, válido 60 s, atado a `userId` y `businessId`.
- **Payload mínimo:** solo ids. El front vuelve a pedir `GET /v1/orders/:id`, igual que hoy con `refreshOrder`.
- **Keep-alive** cada 25 s para que Traefik no corte la conexión. `EventSource` reconecta solo.
- **Robustez:** si la conexión LISTEN se cae, el hub reconecta con backoff y emite `event: resync` para que el front recargue la lista.
- **Escala:** una instancia alcanza para la etapa de validación. Con varias instancias, cada una escucha el mismo canal y funciona igual.
- **Seguimiento público** (`/:slug/order/:code`): polling cada 15 s a `GET /v1/public/.../orders/:code`, igual que hoy.

## 9. Emails (Resend)

| Email | Disparador | Link |
| --- | --- | --- |
| Verificar cuenta | `register`, `resend-verification` | `${FRONT_URL}/verify-email?token=` |
| Recuperar contraseña | `forgot-password` | `${FRONT_URL}/reset-password?token=` |

- `lib/mailer.ts` de back-lamelas, con Resend por SMTP (`smtp.resend.com:465`).
- Sin `SMTP_HOST` en desarrollo, los emails se imprimen en consola.
- **Nunca** se envía un email dentro de una transacción de BD: primero commit, después envío (bug de SMTP en transacción ya visto en Lamelas).

## 10. Errores

Formato uniforme, igual que back-lamelas:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Ingresá la dirección de entrega.", "details": [{ "field": "deliveryAddress", "message": "Requerido" }] } }
```

| HTTP | `code` | Uso |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Zod falló o regla de negocio del pedido (stock, mínimo, cupón) |
| 401 | `UNAUTHORIZED` | Token o API key ausente, expirado o inválido |
| 403 | `FORBIDDEN` / `EMAIL_NOT_VERIFIED` | Rol insuficiente, sin membresía o email sin verificar |
| 404 | `NOT_FOUND` | No existe o RLS lo oculta (indistinguible a propósito) |
| 409 | `CONFLICT` / `BUSINESS_CLOSED` | Slug o email duplicado, negocio cerrado, borrador ya cerrado |
| 429 | `RATE_LIMITED` | Rate limit |
| 500 | `INTERNAL` | Error no manejado (sin detalles internos) |

Las excepciones de las funciones SQL (`raise exception 'La venta no tiene productos'`) se traducen a 400 con el mensaje original, porque ya están escritas para el usuario.

## 11. Configuración (`.env`)

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://toki_app:<hex>@toki-db:5432/toki            # runtime (RLS)
DATABASE_URL_MIGRATE=postgresql://toki_owner:<hex>@toki-db:5432/toki  # migraciones
DATABASE_URL_LISTEN=postgresql://toki_app:<hex>@toki-db:5432/toki     # realtime (puede ser igual a DATABASE_URL)
CORS_ORIGIN=https://toki-v1-delivery.vercel.app,http://localhost:5173
FRONT_URL=https://toki-v1-delivery.vercel.app
JWT_SECRET=<openssl rand -hex 32>
AGENT_API_KEY_SHA256=<sha256 de la key que usa n8n>
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=<RESEND_API_KEY>
EMAIL_FROM="Toki <no-reply@<dominio>>"
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_PUBLIC=toki-public
R2_BUCKET_PRIVATE=toki-private
R2_PUBLIC_URL=https://img.<dominio>
ZERNIO_API_KEY=
ZERNIO_BASE_URL=https://zernio.com/api/v1
```

**Reglas:**

- Passwords en connection strings siempre con `openssl rand -hex 32`, nunca base64 (el `/` rompió la conexión en Lamelas).
- La app se niega a arrancar en producción sin `JWT_SECRET`, `CORS_ORIGIN` o `AGENT_API_KEY_SHA256`.

## 12. Deploy (Dokploy)

1. **`toki-db`:** servicio Postgres (`postgres:17`), base `toki`, usuario `toki_owner`, sin puerto externo, backups diarios a `toki-backups`.
2. **Bootstrap (una vez):** correr `scripts/bootstrap-prod.sql` como `toki_owner` para crear `toki_app` con password fuerte **antes** del primer deploy.
3. **`toki-api`:** servicio desde GitHub (`main`, Auto Deploy), build con `Dockerfile`, dominio `api.<dominio>` con HTTPS en Traefik, env del §11.
4. **Entrypoint:** `prisma migrate deploy` con `DATABASE_URL_MIGRATE` → `node dist/server.js` con `DATABASE_URL`.
5. **Healthcheck:** `GET /v1/health` → `{ ok: true, db: "up" }`.

**Dockerfile:** el mismo multi-stage Debian de back-lamelas (`node:22-slim`, `openssl`, toolchain para bcrypt en el builder).

## 13. Tests

| Capa | Qué | Dónde |
| --- | --- | --- |
| Integración RLS | Dos negocios: A no ve ni modifica datos de B; `staff` no edita catálogo; `anon` no ve pedidos | `test/rls.test.ts` |
| Pedidos | Cálculo (opciones obligatorias, stock, mínimo, cupón, envío), negocio cerrado, idempotencia de confirmación de borrador | `test/orders-pricing.test.ts`, `test/public-orders.test.ts` |
| Auth | Registro, verificación, login bloqueado sin verificar, rotación, reuso de refresh revocado, reset | `test/auth.test.ts` |
| Agente | API key, dedup de mensajes, tools principales | `test/agent.test.ts` |
| Contrato | Endpoints públicos no exponen datos privados (tests anti-fuga) | `test/public.test.ts` |

Postgres local de Homebrew, base `toki_test`. `npm run test:prepare` aplica las 3 migraciones y el seed.

Al terminar una tarea: `npm run lint && npx tsc --noEmit && npm run build && npm test`.

## 14. Checklist de seguridad

- [ ] `toki_app` con `NOINHERIT`, sin `BYPASSRLS` propio, password hex.
- [ ] Postgres sin puerto externo; migración de datos por túnel SSH.
- [ ] CORS con allowlist en producción.
- [ ] Rate limit: login y forgot-password 5/min por IP; checkout 20/min por IP; public GET 120/min.
- [ ] Endpoints públicos sin campos privados (`customer_phone` de otros, notas internas, tokens).
- [ ] API key del agente hasheada y rotable.
- [ ] Tokens y contraseñas nunca en logs.
- [ ] Emails fuera de transacciones.
- [ ] Backups probados con restore antes de migrar datos reales.
