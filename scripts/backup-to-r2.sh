#!/bin/sh
# Backup de la base a Cloudflare R2.
#
# Hace un dump comprimido, lo sube al bucket de backups y borra los que pasaron
# la retención. Pensado para correr una vez por día desde un Scheduled Task de
# Dokploy, dentro de un contenedor que tenga postgresql-client y aws-cli.
#
#   sh scripts/backup-to-r2.sh
#
# Variables necesarias:
#   DATABASE_URL_MIGRATE   conexión con permisos de lectura total (rol dueño)
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   R2_BUCKET_BACKUPS      por defecto: toki-backups
#   BACKUP_RETENTION_DAYS  por defecto: 30
#
# El archivo queda como toki/YYYY/MM/toki-YYYYMMDD-HHMMSS.dump.gz
# Formato custom de pg_dump (-Fc): se restaura selectivamente con pg_restore.
set -eu

: "${DATABASE_URL_MIGRATE:?Falta DATABASE_URL_MIGRATE}"
: "${R2_ACCOUNT_ID:?Falta R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY_ID:?Falta R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?Falta R2_SECRET_ACCESS_KEY}"

BUCKET="${R2_BUCKET_BACKUPS:-toki-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
PREFIX="toki/$(date -u +%Y/%m)"
NAME="toki-${STAMP}.dump.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
# R2 rechaza el checksum que el SDK nuevo manda por defecto.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

echo "[backup] Dump de la base..."
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL_MIGRATE" \
  | gzip -9 > "$TMP/$NAME"

SIZE="$(wc -c < "$TMP/$NAME")"
# Un dump sano de una base con datos nunca pesa 5 KB: si pesa eso, algo falló
# y no queremos pisar la rotación con un archivo vacío.
if [ "$SIZE" -lt 5120 ]; then
  echo "[backup] ERROR: el dump pesa ${SIZE} bytes. No se sube." >&2
  exit 1
fi

echo "[backup] Subiendo ${NAME} (${SIZE} bytes) a s3://${BUCKET}/${PREFIX}/"
aws s3 cp "$TMP/$NAME" "s3://${BUCKET}/${PREFIX}/${NAME}" --endpoint-url "$ENDPOINT"

echo "[backup] Borrando backups de más de ${RETENTION_DAYS} días..."
CUTOFF="$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null \
  || date -u -v-"${RETENTION_DAYS}"d +%Y-%m-%dT%H:%M:%S)"

aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "toki/" --endpoint-url "$ENDPOINT" \
  --query "Contents[?LastModified<='${CUTOFF}'].Key" --output text 2>/dev/null \
  | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' \
  | while read -r key; do
      echo "[backup]   - $key"
      aws s3 rm "s3://${BUCKET}/${key}" --endpoint-url "$ENDPOINT" >/dev/null
    done

echo "[backup] Listo: ${PREFIX}/${NAME}"
