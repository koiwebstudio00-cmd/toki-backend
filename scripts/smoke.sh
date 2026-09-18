#!/bin/sh
# Smoke test contra un deploy. Verifica lo mínimo que tiene que andar antes de
# mandar tráfico real. No escribe nada: solo lee.
#
#   sh scripts/smoke.sh https://api.tudominio.com
#   sh scripts/smoke.sh https://api.tudominio.com toki-demo   # con un slug real
set -eu

BASE="${1:?Uso: sh scripts/smoke.sh <base-url> [slug]}"
SLUG="${2:-}"
BASE="${BASE%/}"
FAILS=0

check() {
  name="$1"; expected="$2"; shift 2
  actual="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [ "$actual" = "$expected" ]; then
    echo "  ok    $name ($actual)"
  else
    echo "  FALLA $name: esperaba $expected, vino $actual"
    FAILS=$((FAILS + 1))
  fi
}

echo "Smoke test de $BASE"

echo "[1/4] Salud"
body="$(curl -s "$BASE/v1/health")"
echo "  $body"
case "$body" in
  *'"ok":true'*) echo "  ok    health responde" ;;
  *) echo "  FALLA health"; FAILS=$((FAILS + 1)) ;;
esac
case "$body" in
  *'"db":"up"'*) echo "  ok    base conectada" ;;
  *) echo "  FALLA la API no llega a la base"; FAILS=$((FAILS + 1)) ;;
esac

echo "[2/4] Rutas protegidas piden sesión"
check "GET /v1/orders sin token" 401 "$BASE/v1/orders"
check "GET /v1/dashboard/summary sin token" 401 "$BASE/v1/dashboard/summary"
check "GET /v1/agent/draft sin API key" 401 "$BASE/v1/agent/draft"

echo "[3/4] Rutas públicas"
check "menú inexistente" 404 "$BASE/v1/public/businesses/no-existe-este-negocio"
if [ -n "$SLUG" ]; then
  check "menú de $SLUG" 200 "$BASE/v1/public/businesses/$SLUG"
fi

echo "[4/4] HTTPS y cabeceras"
headers="$(curl -sI "$BASE/v1/health")"
case "$headers" in
  *"x-powered-by"*|*"X-Powered-By"*) echo "  FALLA x-powered-by expuesto"; FAILS=$((FAILS + 1)) ;;
  *) echo "  ok    sin x-powered-by" ;;
esac
case "$BASE" in
  https://*) echo "  ok    HTTPS" ;;
  *) echo "  FALLA la URL no es HTTPS"; FAILS=$((FAILS + 1)) ;;
esac

echo
if [ "$FAILS" -eq 0 ]; then
  echo "Todo bien."
else
  echo "$FAILS verificación(es) fallaron."
  exit 1
fi
