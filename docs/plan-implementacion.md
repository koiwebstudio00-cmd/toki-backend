# Toki API — Plan de implementación

**Fecha:** 2026-09-17 · **Reemplaza a:** `plan-backend.md` (versiones anteriores con Supabase o Vercel, descartadas)

**Decisión final:** Express + Prisma + PostgreSQL 17 en VPS con Dokploy, R2 para archivos, Resend para emails. Base replicada de Supabase y migración de datos al final.

**Modo de trabajo** (mismo que Lamelas): Claude escribe el código en el repo; Cacho corre `npm install`, migraciones, tests y deploy en su Mac y pega la salida.

| Fase | Contenido | Entregable | Estimación |
| --- | --- | --- | --- |
| **F0. Base** ✅ 2026-09-17 | Repo `toki-api` con el esqueleto de back-lamelas (config, errores, logging, mailer, R2, Zernio, Dockerfile, tests). Prisma con `schema.prisma` + migraciones `0001`–`0003`. `withDb`, `requireAuth`, `requireBusiness`, `requireApiKey`, rate limit. Módulo `health`. Seed con 2 negocios. Tests RLS | `npm test` en verde contra `toki_test`; `GET /v1/health` local | 1-2 días |
| **F1. Auth y cuenta** ✅ 2026-09-17 | `auth` (9 rutas) con emails de Resend; `account` | Registro → email → verificación → login → refresh → reset, con tests | 1-2 días |
| **F2. Negocio y catálogo** ✅ 2026-09-17 | `businesses`, `settings`, `coupons`, `catalog`, `uploads` | CRUD completo con tests de rol (staff no edita) | 2-3 días |
| **F3. Pedidos** ✅ 2026-09-18 | `orders/pricing.ts` (port de `create-order`), `public` (menú, cupón, checkout, seguimiento), `orders` (tablero, estados, pago, POS, comprobantes), realtime SSE, `customers`, `dashboard` | Pedido web de punta a punta con tiempo real; tests de cálculo | 3-4 días |
| **F4. WhatsApp y agente** ✅ 2026-09-18 | `whatsapp` (conexión Zernio, inbox), `agent` (17 rutas); recablear `toki-agent-v2.json` | Conversación real que arma y confirma un pedido | 2-3 días |
| **F5. Infra** ✅ 2026-09-18 | Dokploy: `toki-db`, bootstrap, `toki-api`, dominio, backups a R2 con restore probado; buckets R2 con CORS; dominio en Resend | API en producción con base vacía y health OK | 1 día |
| **F6. Front** ✅ 2026-09-19 | Cliente HTTP (`src/lib/api.ts`) con refresh automático; reemplazar `supabase-js` pantalla por pantalla usando la columna "Origen" de `api.md`; SSE en `OrdersPage` y `DashboardShell`; subida a R2 | Front sin referencias a Supabase; `npm run build` y `lint` OK | 3-4 días |
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

**F2 terminada (2026-09-17).**

- **Módulos:** `businesses` (10 rutas), `settings` (10), `coupons` (4), `catalog` (categorías 5, productos 7, ingredientes 4) y `uploads` (1).
- **Tests:** 104 en verde en total. Los nuevos cubren permisos por rol, aislamiento entre negocios, validaciones, transacción del alta de productos, sincronización de opciones por id, imágenes propias y horarios especiales que cierran el negocio.
- **Decisiones:**
  - `GET /coupons` solo para owner y admin (por RLS).
  - Onboarding crea `payment_settings`.
  - Slugs reservados.
  - Las opciones de producto conservan ids.
- **Utilidades nuevas:** `lib/request.ts` (`businessScope`), `lib/validation.ts`, `lib/time.ts`, y `isAllowedImageUrl` / `deleteReplacedImage` en `lib/r2.ts`.

**F3 terminada (2026-09-18).**

- **Módulos:** `public` (5 rutas), `orders` (9 incluyendo el stream SSE), `customers` (2) y `dashboard` (2).
- **Compartido:** `orders/pricing.ts` (port de `buildOrderPayload`), `lib/realtime.ts` (LISTEN/NOTIFY) y `lib/tickets.ts` (ticket de un uso para SSE).
- **Tests:** 168 en verde en total (64 nuevos): checkout de punta a punta, cupones, stock, opciones, aislamiento entre negocios, POS, comprobantes, agregados del panel y ruteo de eventos.
- **Migraciones nuevas:** `0004` (grants que faltaban) y `0005` (stock respeta `track_stock`, hallazgo H5).
- **Decisiones:**
  - `mercadopago` se rechaza en el checkout mientras no esté integrado el cobro.
  - La venta presencial recibe ids de opciones, no precios: los recargos salen de la base.
  - Aprobar un comprobante no marca el pedido pagado (sigue siendo `mark-paid`).
  - El menú público esconde los valores de opción sin stock.

**F4 terminada (2026-09-18).**

- **Módulos:** `whatsapp` (6 rutas: integración, conexión con Zernio e inbox) y `agent` (18 rutas con API key).
- **Tests:** 215 en verde en total (47 nuevos). El camino borrador → confirmar → pedido está cubierto de punta a punta, incluyendo idempotencia y todos los motivos de rechazo.
- **Migraciones nuevas:** `0006` (idempotencia de comprobantes) y `0007` (las funciones `agent_*` también respetan `track_stock`).
- **Decisiones:**
  - La confirmación devuelve `{ ok: false, error }` con HTTP 200: el request de n8n está bien, lo que falla es el pedido, y el agente lo explica.
  - Confirmar dos veces devuelve el mismo pedido (`yaExistia`).
  - El comprobante solo se guarda si hay un pedido al que atarlo.
  - Se agregó `GET /agent/draft` (faltaba en el contrato; el agente necesita releer el borrador).
- **Pendiente para el deploy:** recablear `toki-agent-v2.json` con la URL pública (tabla de equivalencias en `docs/fases/fase4.md`).

**F5 terminada (2026-09-18).** Todo listo para desplegar; la ejecución es de Cacho (necesita el VPS y las credenciales).

- **Entregables:** `docs/deploy.md` (guía completa), `docker-compose.yml`, `.env.production.example`, `scripts/backup-to-r2.sh`, `scripts/restore-from-r2.sh`, `scripts/smoke.sh`.
- **Tests:** 227 en verde (12 nuevos, sin base de datos): la app no arranca mal configurada en producción, los scripts parsean, la base no expone puerto, la imagen no corre como root y el ejemplo de producción no tiene secretos.
- **Decisiones:** base sin puerto publicado; el compose exige los secretos en vez de usar defaults; el backup no sube dumps sospechosamente chicos; el restore no puede apuntar a producción.

**F6 terminada (2026-09-19).** Se commitea en el repo `toki` (rama `fase6`), no acá.

- **Cliente nuevo:** `src/lib/api/` con sesión, refresh automático, errores con código, SSE y una capa que traduce camelCase ↔ snake_case para no renombrar medio front.
- **25 pantallas migradas**; se elimina `src/lib/supabase/` y la dependencia `@supabase/supabase-js`.
- **Verificado:** `tsc -b` y `eslint` sin errores. El bundle de Vite lo corre Cacho (falta el binario nativo de rollup en el entorno de trabajo).
- **En `toki-api`:** `GET /customers` devuelve `lastAddress`, y un test de horarios que dependía de la hora quedó determinista. 229 tests en verde.
- **Dos mejoras de seguridad de paso:** el checkout ya no se baja la lista de cupones al navegador, y el POS manda ids en vez de precios.

**Siguiente:** F7 (migración de datos y corte).

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
