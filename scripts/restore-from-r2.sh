#!/bin/sh
# Restore de un backup de R2. Un backup que nunca se restauró no es un backup.
#
#   sh scripts/restore-from-r2.sh --list
#   sh scripts/restore-from-r2.sh toki/2026/09/toki-20260918-030000.dump.gz postgresql://toki_owner:...@localhost:5432/toki_restore
#
# El segundo argumento es la base DESTINO. Por seguridad tiene que tener
# "restore" o "staging" en el nombre: este script no pisa producción. Para un
# restore real de producción, hacelo a mano con pg_restore y con la API apagada.
set -eu

: "${R2_ACCOUNT_ID:?Falta R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY_ID:?Falta R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?Falta R2_SECRET_ACCESS_KEY}"

BUCKET="${R2_BUCKET_BACKUPS:-toki-backups}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

if [ "${1:-}" = "--list" ] || [ $# -eq 0 ]; then
  echo "Backups disponibles en s3://${BUCKET}:"
  aws s3 ls "s3://${BUCKET}/toki/" --recursive --endpoint-url "$ENDPOINT" | sort
  exit 0
fi

KEY="$1"
TARGET="${2:?Falta la URL de la base destino}"

case "$TARGET" in
  *restore*|*staging*) ;;
  *)
    echo "ERROR: la base destino tiene que llamarse *restore* o *staging*." >&2
    echo "       Este script no restaura sobre producción a propósito." >&2
    exit 1
    ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[restore] Bajando ${KEY}..."
aws s3 cp "s3://${BUCKET}/${KEY}" "$TMP/backup.dump.gz" --endpoint-url "$ENDPOINT"
gunzip "$TMP/backup.dump.gz"

echo "[restore] Restaurando en la base destino..."
# --clean --if-exists: la base destino puede tener una versión anterior.
# Los errores de ownership son esperados (el dump va sin owner) y no frenan.
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$TARGET" "$TMP/backup.dump" || true

echo "[restore] Verificando..."
psql "$TARGET" -c "select
  (select count(*) from public.businesses) as negocios,
  (select count(*) from public.orders)     as pedidos,
  (select count(*) from public.products)   as productos,
  (select count(*) from auth.users)        as usuarios;"

echo "[restore] Listo. Revisá que los números tengan sentido antes de dar el backup por bueno."
