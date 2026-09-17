# Toki API — Plan de implementación

**Fecha:** 2026-09-17 · **Reemplaza a:** `plan-backend.md` (versiones anteriores con Supabase o Vercel, descartadas)

**Decisión final:** Express + Prisma + PostgreSQL 17 en VPS con Dokploy, R2 para archivos, Resend para emails. Base replicada de Supabase y migración de datos al final.

**Modo de trabajo** (mismo que Lamelas): Claude escribe el código en el repo; Cacho corre `npm install`, migraciones, tests y deploy en su Mac y pega la salida.

| Fase | Contenido | Entregable | Estimación |
| --- | --- | --- | --- |
| **F0. Base** ✅ 2026-09-17 | Repo `toki-api` con el esqueleto de back-lamelas (config, errores, logging, mailer, R2, Zernio, Dockerfile, tests). Prisma con `schema.prisma` + migraciones `0001`–`0003`. `withDb`, `requireAuth`, `requireBusiness`, `requireApiKey`, rate limit. Módulo `health`. Seed con 2 negocios. Tests RLS | `npm test` en verde contra `toki_test`; `GET /v1/health` local | 1-2 días |
| **F1. Auth y cuenta** ✅ 2026-09-17 | `auth` (9 rutas) con emails de Resend; `account` | Registro → email → verificación → login → refresh → reset, con tests | 1-2 días |
| **F2. Negocio y catálogo** | `businesses`, `settings`, `coupons`, `catalog`, `uploads` | CRUD completo con tests de rol (staff no edita) | 2-3 días |
| **F3. Pedidos** | `orders/pricing.ts` (port de `create-order`), `public` (menú, cupón, checkout, seguimiento), `orders` (tablero, estados, pago, POS, comprobantes), realtime SSE, `customers`, `dashboard` | Pedido web de punta a punta con tiempo real; tests de cálculo | 3-4 días |
| **F4. WhatsApp y agente** | `whatsapp` (conexión Zernio, inbox), `agent` (17 rutas); recablear `toki-agent-v2.json` | Conversación real que arma y confirma un pedido | 2-3 días |
| **F5. Infra** | Dokploy: `toki-db`, bootstrap, `toki-api`, dominio, backups a R2 con restore probado; buckets R2 con CORS; dominio en Resend | API en producción con base vacía y health OK | 1 día |
| **F6. Front** | Cliente HTTP (`src/lib/api.ts`) con refresh automático; reemplazar `supabase-js` pantalla por pantalla usando la columna "Origen" de `api.md`; SSE en `OrdersPage` y `DashboardShell`; subida a R2 | Front sin referencias a Supabase; `npm run build` y `lint` OK | 3-4 días |
| **F7. Migración de datos y corte** | Comparar schema real de Supabase vs `0001` (H1); ensayo en staging; ventana de migración (`base-de-datos.md` §9); smoke test; Supabase en solo lectura una semana | Pilotos operando en el VPS | 1 día |

**Total estimado:** 14 a 20 días hábiles. F6 puede avanzar en paralelo desde F2, módulo por módulo.

## Estado

**F0 terminada (2026-09-17).**

- **Esqueleto:** config, `withDb` con roles de contexto, `mapDbError`, `requireAuth`, `requireBusiness`/`requireRole`, `requireApiKey`, rate limits, libs (tokens, passwords, mailer, R2, Zernio, money), `health`, Dockerfile y entrypoint.
- **BD y seed:** scripts de migración con rol `toki_app`, seed de 2 negocios.
- **Tests:** 31 en verde, entre ellos aislamiento RLS, contextos y middlewares.
- **Verificado:** lint, typecheck, build; arranque y cierre limpio del server.
- **Pendiente en la Mac:** `npm install`, `npm run db:migrate:deploy` con Prisma real (en el sandbox se aplicaron con `MIGRATE_WITH=sql`), `npm run test:prepare && npm test`.

**F1 terminada (2026-09-17).**

- **Módulos:** `auth` (9 rutas) y `account` (2 rutas), con templates de email (verificación y reset, texto + HTML).
- **Tests:** 60 en verde en total. 27 cubren el flujo completo de auth (registro, verificación, rotación y robo de refresh, logout, reset, `me`, perfil y RLS del perfil) y 2 la compatibilidad con hashes `$2a$` de Supabase.
- **Para el front (F6):** agregar la ruta `/verify-email`; el reset ya existe en `/reset-password`.

**Siguiente:** F2 (negocio y catálogo).

## Orden y dependencias

```text
F0 ─► F1 ─► F2 ─► F3 ─► F4
             │           │
             └─► F6 ◄────┘  (el front migra a medida que cada módulo queda listo)
F5 puede hacerse en cualquier momento después de F0 (conviene antes de F6 para probar contra la API real)
F7 al final, con todo lo anterior verificado
```

## Criterio de "terminado" por fase

- `npm run lint && npx tsc --noEmit && npm run build && npm test` sin errores.
- Si tocó acceso a datos: test de aislamiento con 2 negocios.
- Si tocó el contrato: `api.md` actualizado.
- Si tocó el schema: migración nueva revisada + `schema.prisma` actualizado.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| El schema real de Supabase difiere del repo (H1) | Primer paso de F7: `pg_dump --schema-only` de producción vs `0001`, y migración de ajuste si hace falta |
| Port de `create-order` con diferencias sutiles de cálculo | Tests con los mismos casos del checklist `ORDERS-CHECKOUT-POS-QA.md` antes de exponer el endpoint |
| Cookies o sesión en Safari | Resuelto por diseño: Bearer + refresh en el cliente |
| El VPS compartido con Lamelas se queda corto de recursos | Monitorear RAM y CPU en Dokploy; separar VPS si hace falta. Postgres de Toki con `shared_buffers` moderado |
| Emails a spam | SPF, DKIM y DMARC del dominio en Resend antes de F1 en producción |
