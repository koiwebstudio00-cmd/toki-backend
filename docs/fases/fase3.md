# Fase 3 — Pedidos, checkout público, tiempo real, clientes y dashboard

**Rama:** `fase3` (sale de `dev`) · **Fecha:** 2026-09-18 · **Tests:** 168 en verde (104 antes, 64 nuevos)

Con esta fase el pedido funciona de punta a punta: un cliente entra al menú, arma el carrito, paga y el pedido aparece solo en el tablero del negocio. Es el reemplazo de la Edge Function `create-order` y de Supabase Realtime.

---

## 1. Qué se construyó

### Módulo `public` (sin sesión) — 5 rutas

El menú del cliente final. Hoy el front hace seis consultas a Supabase para pintar esta pantalla; ahora es una sola.

| Ruta | Qué hace |
| --- | --- |
| `GET /v1/public/businesses/:slug` | Negocio, si está abierto, horarios, horarios especiales de los próximos 14 días, categorías, productos con opciones, medios de pago y fidelización |
| `GET /v1/public/businesses/:slug/products/:id` | Detalle de un producto disponible |
| `POST /v1/public/businesses/:slug/coupons/validate` | Valida un cupón y devuelve cuánto descuenta |
| `POST /v1/public/businesses/:slug/orders` | Checkout |
| `GET /v1/public/businesses/:slug/orders/:code` | Seguimiento del pedido por código |

El menú **no expone** stock, código de barras ni umbrales: un cliente final no ve datos internos. Los valores de opción sin stock directamente no se ofrecen, así el carrito no se arma con algo que después el checkout va a rechazar.

### `orders/pricing.ts` — el único lugar donde se calcula un total

Port de `buildOrderPayload` de la Edge Function. Ni el front ni (más adelante) el agente de WhatsApp mandan precios: mandan productos. Valida, en este orden:

1. Medio de pago habilitado en el negocio.
2. Productos existentes, del negocio y disponibles.
3. Cantidades entre 1 y 50, y stock del producto.
4. Opciones: obligatorias, mínimos y máximos por grupo, valores disponibles, stock de cada valor, y que el valor pertenezca al producto.
5. Precio unitario = precio del producto + suma de recargos.
6. Subtotal ≥ mínimo del negocio, envío si es delivery, cupón (vigencia, usos, mínimo) con tope en el subtotal.
7. Código `TK-XXXXXX` único.

Después llama a `persist_order`, que en una sola transacción de Postgres crea o actualiza el cliente, guarda el pedido con items y opciones, descuenta stock, suma puntos de fidelización y marca el uso del cupón.

### Módulo `orders` (panel) — 9 rutas

Tablero con filtros (estado, origen, rango de fechas, texto libre) y paginado; detalle; cambio de estado con historial; marcar cobrado; venta presencial (POS); comprobantes de transferencia con URL firmada; y el stream de tiempo real.

### Tiempo real: LISTEN/NOTIFY + SSE

Reemplazo de `supabase.channel(...)`:

1. El trigger de la migración `0003` emite un `NOTIFY` en cada alta, cambio o baja de pedido.
2. La API mantiene **una** conexión dedicada escuchando ese canal (`lib/realtime.ts`).
3. El dashboard pide un **ticket** (`POST /v1/orders/events/ticket`) y abre el stream con `?ticket=`. El ticket vale 60 segundos, sirve una sola vez y solo habilita escuchar eventos de ese negocio.
4. Por el canal viajan **solo ids** (`{ orderId, op }`): el front pide el pedido por la API y RLS vuelve a decidir qué se ve.
5. Si se cae la conexión con Postgres, la API reconecta sola y manda un evento `resync` para que el front recargue la lista.

El ticket existe porque `EventSource` del navegador no manda headers, así que el Bearer no puede viajar en la suscripción.

### Módulos `customers` y `dashboard`

`GET /v1/customers` devuelve cantidad de pedidos, total gastado y último pedido **calculados en SQL**. Hoy `CustomersPage` se baja todos los pedidos y los agrega en el navegador.

`GET /v1/dashboard/summary` hace lo mismo con el panel: ventas de hoy, semana y mes, pedidos por estado, ticket promedio, serie de ventas por día (con los días en cero incluidos, para que el gráfico no salte), productos más vendidos, stock bajo de productos, opciones e insumos, últimos 10 pedidos, estado del bot y conversaciones abiertas. Todo en la **zona horaria del negocio**: "hoy" no depende del reloj de quien mira la pantalla.

`GET /v1/dashboard/search` usa la función `search_dashboard` (busca sin acentos y con trigramas).

---

## 2. Dos problemas que aparecieron y cómo se resolvieron

### Migración `0005` — el stock bloqueaba productos que no llevan stock

`persist_order` y `create_manual_sale` comparaban el stock **siempre**, aunque el producto tuviera `track_stock = false` (y por lo tanto `stock_quantity` en 0, que es el default de la tabla). Resultado: un producto para el que decidiste no llevar stock quedaba imposible de vender, con el mensaje "Stock insuficiente".

Peor: las dos funciones ponían `track_stock = true` al descontar. Bastaba una venta para que un producto sin control de stock empezara a controlarlo y se pausara solo al llegar a cero.

Hoy no se nota en producción porque el panel activa `track_stock` siempre. Igual está corregido: el stock se valida y se descuenta solo cuando `track_stock` está activo. Para todo lo que ya lleva stock el comportamiento es idéntico.

### Migración `0004` — permisos que el dump no trajo

Dos cosas que Supabase daba de fábrica y el `pg_dump` del schema no incluyó:

- `EXECUTE` de `business_is_open` para `anon` → el menú público fallaba con `permission denied`.
- `USAGE` sobre el esquema `extensions` (ahí viven `unaccent` y `pg_trgm`) → el buscador del panel fallaba igual.

Quedó anotado como hallazgo **H6** en `docs/base-de-datos.md`: al comparar la réplica con el schema real de Supabase (paso 1 de la F7) hay que revisar si faltan más grants.

---

## 3. Resultado de los tests

```
Test Files  11 passed (11)
     Tests  168 passed (168)
  Duration  ~23 s
```

| Archivo | Tests | Qué cubre |
| --- | --- | --- |
| `test/public.test.ts` | 26 | Menú, detalle, cupones (vencido, agotado, bajo mínimo, de otro negocio), checkout completo, envío, fidelización, negocio cerrado, mínimo, stock, opciones obligatorias y máximos, opción de otro producto, medio de pago deshabilitado, mercadopago, producto de otro negocio, seguimiento |
| `test/orders.test.ts` | 22 | Listado con items y pagos, filtros, paginado, staff, aislamiento entre negocios, estados con historial, cobro, venta presencial (precios de la base, descuento, opción inválida), comprobantes, tickets y ruteo de eventos |
| `test/dashboard.test.ts` | 16 | Ventas del día, pedido cancelado que no suma, serie completa de días, top de productos, stock bajo, aislamiento, buscador y clientes con agregados |
| Fases anteriores | 104 | Sin cambios |

También pasan `npm run lint`, `npm run typecheck` y `npm run build`.

---

## 4. Cómo probarlo a mano

### Preparar

```bash
cd ~/koi/toki-platform/toki-api
git checkout fase3
npm install
npm run db:migrate:deploy    # aplica 0004 y 0005
npm run seed
npm run dev                  # en otra terminal
```

Guardá el slug y el token en variables:

```bash
SLUG=toki-demo
TOKEN=$(curl -s -X POST localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@burger.test","password":"toki12345"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
echo $TOKEN
```

### 1. Menú público (sin sesión)

```bash
curl -s localhost:3000/v1/public/businesses/$SLUG | python3 -m json.tool | head -40
```

Fijate que venga `isOpen`, `categories`, `products` y `paymentMethods`. Si `isOpen` es `false`, abrí el negocio a mano:

```bash
curl -s -X PATCH localhost:3000/v1/business/status -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"manualStatus":"open"}'
```

### 2. Hacer un pedido como cliente

Agarrá un `productId` del menú y, si el producto tiene una opción obligatoria, un `optionValueIds`:

```bash
PROD=$(curl -s localhost:3000/v1/public/businesses/$SLUG | python3 -c 'import sys,json;print(json.load(sys.stdin)["products"][0]["id"])')

curl -s -X POST localhost:3000/v1/public/businesses/$SLUG/orders -H 'content-type: application/json' -d "{
  \"customer\": {\"name\":\"Ana Prueba\",\"phone\":\"3815550001\"},
  \"orderType\": \"takeaway\",
  \"paymentMethod\": \"cash\",
  \"items\": [{\"productId\":\"$PROD\",\"quantity\":1}]
}" | python3 -m json.tool
```

Tiene que devolver `201` con `orderCode`, `total` y `loyaltyPointsEarned`.

**Casos de error que conviene probar** (todos devuelven un mensaje en español, listo para mostrar):

```bash
# Negocio cerrado
curl -s -X PATCH localhost:3000/v1/business/status -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"manualStatus":"closed"}'
# ...repetir el pedido: 409 BUSINESS_CLOSED. Después volver a "open".

# Cantidad imposible → "No hay stock suficiente de ..."
# Cupón inventado:
curl -s -X POST localhost:3000/v1/public/businesses/$SLUG/coupons/validate \
  -H 'content-type: application/json' -d '{"code":"NOEXISTE","subtotal":10000}'
```

### 3. Seguimiento

```bash
CODE=TK-XXXXXX   # el que devolvió el checkout
curl -s localhost:3000/v1/public/businesses/$SLUG/orders/$CODE | python3 -m json.tool
```

No tiene que traer el teléfono del cliente ni datos internos.

### 4. Tablero

```bash
curl -s localhost:3000/v1/orders -H "authorization: Bearer $TOKEN" | python3 -m json.tool | head -50
curl -s "localhost:3000/v1/orders?search=Ana" -H "authorization: Bearer $TOKEN" | python3 -m json.tool | head -20

ORDER=$(curl -s localhost:3000/v1/orders -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])')

# Cambiar estado (mirá statusHistory en la respuesta)
curl -s -X PATCH localhost:3000/v1/orders/$ORDER/status -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"status":"preparing","note":"Arranca la cocina"}' | python3 -m json.tool | head -20

# Marcar cobrado
curl -s -X POST localhost:3000/v1/orders/$ORDER/mark-paid -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["paymentStatus"], d["payments"])'
```

### 5. Venta presencial (POS)

```bash
curl -s -X POST localhost:3000/v1/orders/manual -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{
  \"paymentMethod\": \"cash\",
  \"items\": [{\"productId\":\"$PROD\",\"quantity\":2}]
}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["orderCode"], d["status"], d["paymentStatus"], d["total"])'
```

Tiene que salir `delivered`, `paid` y el total calculado con los precios de la base.

### 6. Tiempo real (la prueba más linda)

Terminal A — abrir el stream:

```bash
TICKET=$(curl -s -X POST localhost:3000/v1/orders/events/ticket -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["ticket"])')
curl -N "localhost:3000/v1/orders/events?ticket=$TICKET"
```

Queda colgado mostrando `event: ready`. Terminal B — hacer un pedido (el del paso 2). En la terminal A tiene que aparecer al instante:

```
event: order
data: {"orderId":"...","op":"INSERT"}
```

Cambiá el estado del pedido y va a llegar otro evento con `op: "UPDATE"`. Probá también reusar el mismo ticket: la segunda vez tiene que dar `401`.

### 7. Panel y clientes

```bash
curl -s localhost:3000/v1/dashboard/summary -H "authorization: Bearer $TOKEN" | python3 -m json.tool | head -40
curl -s "localhost:3000/v1/dashboard/search?q=burg" -H "authorization: Bearer $TOKEN" | python3 -m json.tool
curl -s localhost:3000/v1/customers -H "authorization: Bearer $TOKEN" | python3 -m json.tool | head -30
```

### 8. Aislamiento entre negocios

Con el token del segundo negocio del seed (`owner@pizza.test`), pedí un pedido del primero por id: tiene que dar `404`.

```bash
TOKEN2=$(curl -s -X POST localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@pizza.test","password":"toki12345"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/v1/orders/$ORDER -H "authorization: Bearer $TOKEN2"
```

### Correr los tests

```bash
npm run test:prepare   # hay migraciones nuevas: es obligatorio
npm test
npm run lint && npm run typecheck && npm run build
```

---

## 5. Lo que queda afuera

- **WhatsApp y el agente** (F4): la confirmación del borrador de WhatsApp va a reusar `orders/pricing.ts` tal como está.
- **Mercado Pago:** el checkout lo rechaza a propósito hasta que esté integrado el cobro.
- **Canje de puntos:** los puntos se acumulan (`loyalty_points_earned`); canjearlos todavía no existe, igual que en Supabase.
- **Subida de comprobantes por el cliente:** se pueden listar y revisar; la subida llega con WhatsApp.
