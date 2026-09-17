#!/bin/sh
# Arranque en producción: primero migrar (rol dueño), después servir (toki_app).
set -e

if [ -z "$DATABASE_URL_MIGRATE" ]; then
  echo "[entrypoint] Falta DATABASE_URL_MIGRATE (rol toki_owner). Ver docs/arquitectura.md §12." >&2
  exit 1
fi

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] Falta DATABASE_URL (rol toki_app)." >&2
  exit 1
fi

echo "[entrypoint] Aplicando migraciones pendientes..."
DATABASE_URL="$DATABASE_URL_MIGRATE" ./node_modules/.bin/prisma migrate deploy

# `exec`: node queda como PID 1 y recibe el SIGTERM de Docker (cierre limpio).
echo "[entrypoint] Migraciones al día. Levantando la API como toki_app."
exec node dist/server.js
