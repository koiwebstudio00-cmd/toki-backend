# toki-api

Backend de Toki: Express + Prisma + PostgreSQL 17, desplegado con Dokploy.

## Arrancar en tu compu

**Guía paso a paso (incluye instalar Postgres): [`docs/setup-local.md`](docs/setup-local.md).**

Resumen para quien ya tiene Postgres 17 andando:

```bash
npm install                     # corre prisma generate
cp .env.example .env            # poner tu usuario de Postgres en las URLs de migrate y test
createdb toki && createdb toki_test
npm run db:migrate:deploy       # crea toki_app y aplica 0001–0003
npm run seed                    # 2 negocios demo (owner@burger.test / toki12345)
npm run dev                     # http://localhost:3000/v1/health
npm run test:prepare && npm test
```

## Documentación

| Doc | Contenido |
| --- | --- |
| [`docs/setup-local.md`](docs/setup-local.md) | Entorno local paso a paso |
| [`docs/descripcion.md`](docs/descripcion.md) | Qué es Toki y qué módulos tiene |
| [`docs/arquitectura.md`](docs/arquitectura.md) | Auth, contextos de BD, estructura, R2, realtime, deploy |
| [`docs/api.md`](docs/api.md) | Contrato de endpoints |
| [`docs/base-de-datos.md`](docs/base-de-datos.md) | Modelo de datos, RLS, migraciones |
| [`docs/stack.md`](docs/stack.md) | Tecnologías y versiones |
| [`docs/deploy.md`](docs/deploy.md) | Deploy en el VPS con Dokploy, backups y checklist |
| [`docs/plan-implementacion.md`](docs/plan-implementacion.md) | Fases y estado |
| [`docs/fases/`](docs/fases/) | Qué se hizo en cada fase, tests y cómo probarla a mano |
| [`CLAUDE.md`](CLAUDE.md) | Reglas del proyecto |

## Estado

Fases 0 a 7 terminadas: base, auth y cuenta, negocio, configuración, cupones, catálogo, uploads, checkout público, pedidos, tiempo real, clientes, dashboard, WhatsApp, agente, infraestructura de deploy, migración del front y scripts de migración de datos.

Cada fase tiene su documento en [`docs/fases/`](docs/fases/) con los resultados de los tests y los comandos para probarla.
