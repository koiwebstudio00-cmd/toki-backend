# Fase 5 — Infraestructura y deploy

**Rama:** `fase5` (sale de `fase4`) · **Fecha:** 2026-09-18 · **Tests:** 227 en verde (215 antes, 12 nuevos)

Esta fase deja todo listo para que el deploy sea correr una guía, sin decisiones pendientes ni valores inventados. Es la única fase que **no puedo ejecutar yo**: necesita tu VPS y tus credenciales.

---

## 1. Qué se construyó

| Archivo | Para qué |
| --- | --- |
| [`docs/deploy.md`](../deploy.md) | La guía completa: secretos, R2, Resend, base, bootstrap, primer deploy, backups y checklist |
| `docker-compose.yml` | Stack para Dokploy: Postgres 17 + API |
| `.env.production.example` | Todas las variables de producción con el comando para generar cada secreto |
| `scripts/backup-to-r2.sh` | Backup diario a R2 con rotación |
| `scripts/restore-from-r2.sh` | Restore verificado (el paso que casi nadie hace) |
| `scripts/smoke.sh` | Verificación post-deploy |
| `test/infra.test.ts` | 12 tests que cubren lo de arriba |

El `Dockerfile` y el `docker-entrypoint.sh` ya estaban de la fase 0 y no se tocaron.

## 2. Decisiones que quedaron tomadas

**La base no expone puerto.** En el compose, `toki-db` no tiene `ports`. Se llega por la red interna de Docker, y desde afuera (para migrar los datos en la fase 7) por túnel SSH. Una base de Postgres con el 5432 abierto a internet se escanea en horas.

**El compose exige los secretos.** `${JWT_SECRET:?...}` hace que el stack **no levante** si falta una variable crítica, en vez de arrancar con un default inseguro. Lo mismo hace `config.ts` dentro de la app: en producción se niega a arrancar con un `JWT_SECRET` corto, sin allowlist de CORS o con una API key del agente que no sea un SHA-256.

**El backup se niega a subir un dump chico.** Si `pg_dump` falla y deja un archivo de 200 bytes, subirlo es peor que no hacer nada: la rotación borra los buenos y te quedás con basura. Corta abajo de 5 KB.

**El restore no puede pisar producción.** El script exige que la base destino se llame `*restore*` o `*staging*`. Un restore real de producción se hace a mano, con la API apagada y sabiendo lo que se hace.

**Postgres con valores moderados** (`shared_buffers=256MB`, `max_connections=100`): el VPS lo compartís con Lamelas.

**Una conexión aparte para el tiempo real** (`DATABASE_URL_LISTEN`): el `LISTEN` vive en una sesión de Postgres y no puede competir por el pool de la API.

## 3. Resultado de los tests

```
Test Files  14 passed (14)
     Tests  227 passed (227)
```

`test/infra.test.ts` (12 nuevos) verifica:

- La app **no arranca** en producción sin `DATABASE_URL`, con `JWT_SECRET` corto, sin `CORS_ORIGIN` o con una API key del agente que no sea un hash.
- En desarrollo sí arranca sin secretos (si no, no se podría trabajar en local).
- Los cuatro scripts de shell no tienen errores de sintaxis.
- La base no expone puerto y tiene healthcheck.
- El compose exige los cinco secretos críticos.
- La imagen corre como `node`, no como root, y tiene healthcheck.
- `.env.production.example` no tiene ningún secreto de verdad (todos son `<placeholder>`).
- `.env` está en `.gitignore`.

Este último grupo parece trivial hasta el día que alguien commitea un `.env` con la API key de Resend.

## 4. Cómo probarlo a mano

### Sin VPS (lo que podés verificar ahora)

```bash
cd ~/koi/toki-platform/toki-api
git checkout fase5

# Los tests de infra no necesitan base de datos
npx vitest run test/infra.test.ts

# Sintaxis de los scripts
sh -n scripts/backup-to-r2.sh && sh -n scripts/restore-from-r2.sh && sh -n scripts/smoke.sh && echo OK

# El compose es válido
docker compose config >/dev/null && echo "compose OK"

# La imagen se construye
docker build -t toki-api:test .
```

Probá que la app se niega a arrancar mal configurada:

```bash
NODE_ENV=production DATABASE_URL=postgresql://x@y/z npx tsx -e "import('./src/config.js')"
# Tiene que fallar nombrando JWT_SECRET, CORS_ORIGIN y AGENT_API_KEY_SHA256
```

### Levantar el stack completo en tu Mac (ensayo del deploy)

```bash
cat > .env.compose <<'EOF'
POSTGRES_PASSWORD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
DATABASE_URL=postgresql://toki_app:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@toki-db:5432/toki
DATABASE_URL_MIGRATE=postgresql://toki_owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@toki-db:5432/toki
CORS_ORIGIN=http://localhost:5173
FRONT_URL=http://localhost:5173
JWT_SECRET=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
AGENT_API_KEY_SHA256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
EOF

docker compose --env-file .env.compose up -d toki-db
sleep 10

# Bootstrap: crear el rol de la API
docker compose exec toki-db psql -U toki_owner -d toki -c \
  "create role toki_app login noinherit password 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; grant connect on database toki to toki_app;"

docker compose --env-file .env.compose up -d --build toki-api
docker compose logs -f toki-api     # tiene que decir "Migraciones al día"
```

Después, desde otra terminal:

```bash
docker compose exec toki-api node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>r.json()).then(console.log)"
```

Y la verificación que más importa: que `toki_app` no pueda leer nada por sí solo.

```bash
docker compose exec toki-db psql -U toki_app -d toki -c "select count(*) from public.businesses;"
# permission denied  ← esto es lo CORRECTO
```

Limpiar:

```bash
docker compose --env-file .env.compose down -v
rm .env.compose
```

### En el VPS

Seguí [`docs/deploy.md`](../deploy.md) de arriba a abajo y cerrá con:

```bash
sh scripts/smoke.sh https://api.tudominio.com
```

## 5. Lo que no puedo hacer yo

Todo lo que necesita tus credenciales: crear los servicios en Dokploy, los buckets de R2, verificar el dominio en Resend, correr el bootstrap y el primer deploy. La guía está escrita para que sea copiar y pegar, y el smoke test te dice si quedó bien.

**El paso que te pido que no saltees:** probar un restore antes de migrar los datos reales de tus pilotos (paso 6 de la guía).
