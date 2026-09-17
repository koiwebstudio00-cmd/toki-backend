# toki-api

Backend de Toki: Express + Prisma + PostgreSQL 17, desplegado con Dokploy. Documentación en `docs/`.

## Primer arranque en la Mac

```bash
cp .env.example .env            # ajustar usuario de Postgres si no es dev0
createdb toki
npm install                     # corre prisma generate
npm run db:migrate:deploy       # crea toki_app y aplica 0001–0003
npm run seed                    # 2 negocios demo
npm run dev                     # http://localhost:3000/v1/health
```

## Tests

```bash
npm run test:prepare            # recrea toki_test
npm test
```

## Estado

Fase 0 (base) terminada. Ver `docs/plan-implementacion.md`.
