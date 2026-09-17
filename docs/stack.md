# Toki API — Stack

**Fecha:** 2026-09-17 · **Criterio:** reutilizar lo que ya está probado en producción en `back-lamelas`. No se suman herramientas nuevas sin acordarlo antes.

## 1. Backend

| Capa | Tecnología | Versión | Motivo |
| --- | --- | --- | --- |
| Runtime | Node.js | 22 LTS | Misma imagen base que back-lamelas (`node:22-slim`) |
| Lenguaje | TypeScript | ^5.7 | `strict`, ESM (`"type": "module"`) |
| Framework HTTP | Express | ^5.1 | Errores async nativos; estructura por módulos de back-lamelas |
| ORM | Prisma (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) | **6.19.3 fijo** | Mismo major que back-lamelas, con `engineType = "client"` (sin binario Rust, GA desde 6.16): el cliente habla con Postgres por el driver `pg`. La imagen no depende del query engine nativo y los tests corren en cualquier entorno. `prisma migrate` sigue igual. Prisma 7: no migrar en esta etapa |
| Validación | Zod | ^3.24 | Schemas por endpoint; mismo major que back-lamelas |
| Base de datos | PostgreSQL | 17 (imagen `postgres:17`, Debian) | Extensiones: `citext`, `pg_trgm`, `unaccent` |
| Driver Postgres | `pg` | ^8 | Lo usa el adapter de Prisma, los scripts de BD y la conexión LISTEN de tiempo real |
| Contraseñas | `bcrypt` | ^6.0 (binarios precompilados, sin toolchain en Docker) | Compatible con los hashes de Supabase Auth (`$2a$`): los usuarios migran sin resetear su contraseña |
| Tokens | `jsonwebtoken` | ^9 | Access JWT HS256, 15 min |
| Emails | `nodemailer` + **Resend** (SMTP) | ^6.9 | Mismo `lib/mailer.ts` que back-lamelas, ya verificado con Resend en producción |
| Storage | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | ^3.700 | Cloudflare R2. Requiere `requestChecksumCalculation: "WHEN_REQUIRED"` (gotcha resuelto en Lamelas) |
| Seguridad HTTP | `helmet`, `cors`, `express-rate-limit` | 8 / 2 / 7 | CORS con allowlist; rate limit en auth y rutas públicas |
| Logs | `morgan` | ^1.11 | Una línea por request; saltea `/v1/health` |
| Config | `dotenv` + Zod | — | La app no arranca en producción si falta un secreto |
| Dev server | `tsx watch` | ^4.19 | — |
| Tests | Vitest + supertest | ^3 / ^7 | Integración contra Postgres local (`toki_test`) |
| Lint | ESLint 9 + typescript-eslint | — | Config copiada de back-lamelas |

**Scripts de `package.json`** (mismos nombres que back-lamelas):

```text
dev                 tsx watch src/server.ts
build               tsc
start               node dist/server.js
lint                eslint .
test                vitest run
typecheck           tsc -p tsconfig.dev.json          # src + test + scripts + seed
db:generate         prisma generate                   # también en postinstall
db:migrate:create   prisma migrate dev --create-only
db:migrate:deploy   tsx scripts/migrate-dev.ts        # crea toki_app (dev) + migra con DATABASE_URL_MIGRATE
test:prepare        tsx scripts/migrate-test.ts       # recrea toki_test y aplica migraciones
seed                tsx prisma/seed.ts                # 2 negocios demo
migrate:supabase    tsx scripts/migrate-supabase.ts   # (F7) migración única de datos y archivos
admin               tsx scripts/admin-cli.ts          # (roadmap) soporte: usuarios, negocios
```

## 2. Infraestructura

| Pieza | Tecnología | Detalle |
| --- | --- | --- |
| Servidor | VPS (Linux) | A definir si se comparte con Lamelas o se usa uno nuevo |
| Orquestación | **Dokploy** | Proyecto `toki`: servicios `toki-api` (Dockerfile) y `toki-db` (`postgres:17`) |
| Proxy / SSL | Traefik (incluido en Dokploy) | HTTPS automático. **Nunca** publicar puertos de los servicios |
| Deploy | Auto Deploy de Dokploy desde GitHub | Push a `main` → build → migraciones en el entrypoint → healthcheck |
| Backups | Backups de Dokploy → R2 (`toki-backups`) | Diario 03:00, retener 7. Restore probado antes de migrar datos |
| Archivos | Cloudflare R2 | `toki-public` (imágenes, lectura pública) y `toki-private` (comprobantes, URL firmada). Un token por bucket |
| Emails | Resend | Dominio con SPF, DKIM y DMARC verificados |
| Front | Vercel | Sin cambios de hosting |
| Automatizaciones / IA | n8n (instancia actual) + OpenAI | Workflow `toki-agent-v2` |
| WhatsApp | Zernio | Webhook → n8n |

## 3. Dominios (a definir)

| Host | Servicio |
| --- | --- |
| `api.<dominio>` | toki-api (Traefik) |
| `app.<dominio>` o `toki-v1-delivery.vercel.app` | Front |
| `img.<dominio>` o subdominio `r2.dev` | Bucket público de R2 |

La API usa **Bearer tokens**, así que front y API pueden vivir en dominios distintos sin problemas de cookies (ver `arquitectura.md` §4).

## 4. Qué NO se usa (y por qué)

| Descartado | Motivo |
| --- | --- |
| Supabase (Auth, Storage, Realtime, PostgREST) | Reemplazado por este backend |
| Prisma Migrate con `migrate dev` directo | Destruye SQL que Prisma no modela (RLS, funciones, índices parciales). Siempre `--create-only` + revisión |
| Prisma 7 | Cambios de configuración que no aportan en esta etapa |
| Socket.IO / WebSockets | El dashboard solo recibe avisos: SSE alcanza |
| Redis / BullMQ | Sin colas por ahora; lo asíncrono lo resuelven n8n y NOTIFY |
| NestJS | El scaffold `toki-backend` queda descartado |
| Docker Compose en producción | Dokploy orquesta los servicios |
