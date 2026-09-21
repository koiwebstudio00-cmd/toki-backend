# Fase 4 — WhatsApp y agente

**Rama:** `fase4` (sale de `fase3`) · **Fecha:** 2026-09-18 · **Tests:** 215 en verde (168 antes, 47 nuevos)

Con esta fase el bot de WhatsApp deja de depender de Supabase: el agente de n8n arma el pedido, lo confirma y guarda el comprobante contra la API propia.

> Como las ramas son acumulativas, `fase4` **incluye** todo lo de `fase3`.

---

## 1. Qué se construyó

### Módulo `whatsapp` (panel) — 6 rutas

Port de las Edge Functions `zernio-whatsapp-start` y `zernio-whatsapp-complete`, más el inbox.

| Ruta | Quién | Qué hace |
| --- | --- | --- |
| `GET /v1/whatsapp/integration` | owner/admin | Estado de la conexión, **sin tokens ni metadata cruda** |
| `POST /v1/whatsapp/connect/start` | owner/admin | Crea o reutiliza el perfil en Zernio y devuelve la URL para conectar |
| `POST /v1/whatsapp/connect/complete` | owner/admin | Activa la integración con la cuenta que devolvió Zernio |
| `GET /v1/conversations` | todo el equipo | Inbox ordenado por último mensaje |
| `GET /v1/conversations/:id/messages` | todo el equipo | Mensajes + el último pedido de ese cliente |
| `PATCH /v1/conversations/:id/status` | todo el equipo | Tomar / devolver / cerrar la conversación |

Dos detalles que se conservan del comportamiento original: la conexión queda **inactiva** hasta que `complete` la confirma con el mismo `profileId` que inició el flujo, y una integración vieja de Meta no se pisa sin aviso (devuelve 409).

### Módulo `agent` (n8n) — 18 rutas

Todas con `X-Api-Key`. Cada request lleva `businessId` y `conversationId`, y las funciones SQL verifican que la conversación sea de ese negocio: **la API key no habilita un negocio en particular**, habilita al agente.

Las respuestas son las mismas que devolvían las RPC `agent_*`, así que **el prompt del agente no cambia**: solo cambia a qué URL le pega n8n.

- **Integración y mensajes:** resolver el negocio desde la cuenta de Zernio, upsert de conversación (no pisa el `handoff`: si un humano la tomó, sigue tomada) y guardado de mensajes con dedup por `providerMessageId`.
- **Catálogo y contexto:** búsqueda de productos, detalle, preguntas frecuentes y contexto de la conversación.
- **Borrador:** ver, agregar item, quitar item, completar datos de a poco, cancelar.
- **Confirmar:** `POST /agent/draft/confirm`.
- **Pedido ya confirmado:** consultar estado, cambiar entrega/pago, sumarle los items nuevos del borrador.
- **Handoff** y **comprobante de pago**.

### La confirmación del pedido

Es el reemplazo de `create-order` en modo whatsapp, y el punto donde más importa el diseño:

**El request no trae items ni precios: trae la conversación.** Los items se leen del borrador que el propio sistema fue escribiendo, así que ni el modelo ni quien llame al endpoint puede inventar un producto, un precio o una cantidad. Después reusa `orders/pricing.ts`, el mismo cálculo del checkout web (fase 3).

Además:

- **Es idempotente.** Confirmar dos veces devuelve el pedido que ya existe (`yaExistia: true`) en vez de crear otro. El webhook se reintenta y el cliente escribe "confirmá" dos veces: las dos cosas pasan.
- **Los errores son texto legible en español** dentro de `{ ok: false, error }` con HTTP 200, para que el agente se lo explique al cliente en vez de decir que el pedido se confirmó. El 200 es a propósito: el request de n8n está bien, lo que falla es el pedido.
- Valida nombre, tipo de entrega, medio de pago, dirección si es delivery, local abierto y stock.

### Comprobantes de pago

`POST /agent/payment-proofs` baja el adjunto de Zernio (máximo 10 MB, solo imagen o PDF), lo sube al bucket **privado** de R2 y deja la fila para que el negocio la revise. Solo lo guarda si hay un pedido al que atarlo: el del código, o el último de esa conversación.

La descarga y la subida quedan fuera de la transacción de base de datos, porque son llamadas de red y no tienen por qué mantener una transacción abierta.

---

## 2. Dos cosas que aparecieron

### Migración `0006` — el webhook reintentado duplicaba comprobantes

`order_payment_proofs` no tenía forma de saber si ya había guardado ese mensaje. Un reintento del webhook dejaba dos archivos en R2 y dos filas para revisar. Ahora hay `provider_message_id` con índice único parcial por negocio, igual que `whatsapp_messages`.

### Migración `0007` — el mismo bug de stock, ahora en el agente

La fase 3 corrigió `persist_order` y `create_manual_sale` (hallazgo H5). Las funciones del agente tenían exactamente el mismo problema: `agent_draft_add_item` contestaba "ese producto no está disponible" para cualquier producto con `track_stock = false`, y `agent_search_products` ni siquiera lo mostraba.

Quedó corregido en las cuatro funciones afectadas, así el agente ve **lo mismo que el menú web**.

---

## 3. Resultado de los tests

```
Test Files  13 passed (13)
     Tests  215 passed (215)
  Duration  ~28 s
```

| Archivo | Tests | Qué cubre |
| --- | --- | --- |
| `test/agent.test.ts` | 31 | API key, resolución del negocio, dedup de mensajes, catálogo, borrador completo, confirmación (feliz, idempotente, faltan datos, local cerrado, sin stock, sin borrador), edición del pedido, handoff y comprobantes (feliz, duplicado, sin pedido, archivo inválido) |
| `test/whatsapp.test.ts` | 16 | Estado sin tokens, permisos de staff, conexión con Zernio (perfil nuevo y reutilizado, URL inválida, integración legacy, completar, perfil que no coincide), inbox, aislamiento y handoff |
| Fases anteriores | 168 | Sin cambios |

`npm run lint`, `npm run typecheck` y `npm run build` pasan.

Los tests **no salen a internet**: las llamadas a Zernio están simuladas.

---

## 4. Cómo probarlo a mano

### Preparar

```bash
cd ~/koi/toki-platform/toki-api
git checkout fase4
npm install
npm run db:migrate:deploy    # aplica 0006 y 0007
npm run seed
npm run dev
```

Para las rutas del agente necesitás una API key. Generala y poné el **hash** en el `.env`:

```bash
KEY=$(openssl rand -hex 32)
echo "AGENT_API_KEY_SHA256=$(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1)" >> .env
echo "Tu API key (guardala, no queda en el servidor): $KEY"
# reiniciar npm run dev para que tome el .env
```

### 1. Conexión de WhatsApp

```bash
TOKEN=$(curl -s -X POST localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@burger.test","password":"toki12345"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')

curl -s localhost:3000/v1/whatsapp/integration -H "authorization: Bearer $TOKEN" | python3 -m json.tool
```

Sin conectar devuelve `{"provider": null, "isActive": false, ...}`. `connect/start` sí llama a Zernio de verdad: si no tenés `ZERNIO_API_KEY` en el `.env`, va a fallar, y eso es lo esperado en local.

### 2. Simular una conversación

Sin WhatsApp conectado podés crear la conversación a mano con `npx prisma studio` (tabla `whatsapp_conversations`: `business_id`, `contact_id`, `phone`) y quedarte con su `id`. Después:

```bash
KEY=<la key que generaste>
BIZ=<business_id>
CONV=<conversation_id>

# Contexto que lee el agente
curl -s "localhost:3000/v1/agent/conversations/$CONV/context?businessId=$BIZ&k=10" \
  -H "x-api-key: $KEY" | python3 -m json.tool | head -40

# Buscar productos
curl -s "localhost:3000/v1/agent/products/search?businessId=$BIZ&q=burger" -H "x-api-key: $KEY" | python3 -m json.tool
```

### 3. Armar el pedido como lo hace el bot

```bash
PROD=<product_id de la búsqueda>

# Agregar al borrador (si el producto tiene opción obligatoria, mandá optionValueIds)
curl -s -X POST localhost:3000/v1/agent/draft/items -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\",\"productId\":\"$PROD\",\"quantity\":2}" | python3 -m json.tool

# Ver el borrador
curl -s "localhost:3000/v1/agent/draft?businessId=$BIZ&conversationId=$CONV" -H "x-api-key: $KEY" | python3 -m json.tool

# Completar datos de a poco (así lo hace el bot: a medida que el cliente los dice)
curl -s -X PATCH localhost:3000/v1/agent/draft -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\",\"customerName\":\"Ana\"}" > /dev/null
curl -s -X PATCH localhost:3000/v1/agent/draft -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\",\"orderType\":\"takeaway\",\"paymentMethod\":\"cash\"}" | python3 -m json.tool
```

**Probá confirmar antes de completar los datos**: tiene que responder `{"ok": false, "error": "Falta ..."}` con 200.

```bash
# Confirmar
curl -s -X POST localhost:3000/v1/agent/draft/confirm -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\"}" | python3 -m json.tool

# Confirmar OTRA VEZ: tiene que decir yaExistia y NO crear un segundo pedido
curl -s -X POST localhost:3000/v1/agent/draft/confirm -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\"}" | python3 -m json.tool
```

Verificá en el tablero que el pedido entró con `source: "whatsapp"`:

```bash
curl -s "localhost:3000/v1/orders?source=whatsapp" -H "authorization: Bearer $TOKEN" | python3 -m json.tool | head -30
```

Y si dejaste abierto el stream de la fase 3, el pedido de WhatsApp también dispara el evento.

### 4. Estado, cambios y handoff

```bash
curl -s "localhost:3000/v1/agent/orders/status?businessId=$BIZ&conversationId=$CONV" -H "x-api-key: $KEY" | python3 -m json.tool

CODE=TK-XXXXXX
curl -s -X PATCH "localhost:3000/v1/agent/orders/$CODE" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\",\"orderType\":\"delivery\",\"deliveryAddress\":\"Av. Siempre Viva 742\"}" | python3 -m json.tool

curl -s -X POST "localhost:3000/v1/agent/conversations/$CONV/handoff" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"reason\":\"queja\"}" | python3 -m json.tool
```

El motivo tiene que ser uno de `pedido_humano`, `queja`, `cancelacion`, `cambio_pedido`, `no_puedo_ayudar`; cualquier otro queda como `no_puedo_ayudar`.

### 5. Inbox desde el panel

```bash
curl -s localhost:3000/v1/conversations -H "authorization: Bearer $TOKEN" | python3 -m json.tool
curl -s "localhost:3000/v1/conversations/$CONV/messages" -H "authorization: Bearer $TOKEN" | python3 -m json.tool

# Tomar la conversación
curl -s -X PATCH "localhost:3000/v1/conversations/$CONV/status" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"status":"handoff"}' | python3 -m json.tool
```

### 6. Seguridad

```bash
# Sin API key
curl -s -o /dev/null -w '%{http_code}\n' "localhost:3000/v1/agent/products/search?businessId=$BIZ"      # 401
# Con key equivocada
curl -s -o /dev/null -w '%{http_code}\n' "localhost:3000/v1/agent/products/search?businessId=$BIZ" -H "x-api-key: nope"  # 401
# Un staff intentando conectar WhatsApp: 403 (probalo con un usuario staff)
```

### Correr los tests

```bash
npm run test:prepare
npm test
npm run lint && npm run typecheck && npm run build
```

---

## 5. Recablear n8n (`toki-agent-v2.json`)

**Ya está hecho** (fase 8): el workflow (`toki-agents/n8n/toki-agent-v2.json`) apunta a la API propia. Queda como referencia la tabla de equivalencias:

| Nodo viejo (Supabase) | Nuevo |
| --- | --- |
| `rest/v1/whatsapp_integrations?...` | `GET /v1/agent/integrations/by-account/:accountId` |
| `rest/v1/whatsapp_conversations` (upsert) | `POST /v1/agent/conversations/upsert` |
| `rest/v1/whatsapp_conversations?select=status` | `GET /v1/agent/conversations/:id?businessId=` |
| `rest/v1/whatsapp_messages` (insert) | `POST /v1/agent/messages` |
| `rest/v1/whatsapp_messages?created_at=gt.` | `GET /v1/agent/conversations/:id/messages?businessId=&after=&direction=&limit=` |
| `rpc/agent_context` | `GET /v1/agent/conversations/:id/context?businessId=&k=` |
| `rpc/agent_search_products` | `GET /v1/agent/products/search?businessId=&q=&limit=` |
| `rpc/agent_product_detail` | `GET /v1/agent/products/:id?businessId=` |
| `rpc/agent_search_faq` | `GET /v1/agent/faq/search?businessId=&q=&limit=` |
| `rpc/agent_draft_get` | `GET /v1/agent/draft?businessId=&conversationId=` |
| `rpc/agent_draft_add_item` | `POST /v1/agent/draft/items` |
| `rpc/agent_draft_remove_item` | `DELETE /v1/agent/draft/items/:itemId?businessId=&conversationId=` |
| `rpc/agent_draft_set_details` | `PATCH /v1/agent/draft` |
| `rpc/agent_order_status` | `GET /v1/agent/orders/status?businessId=&conversationId=&orderCode=` |
| `rpc/agent_order_update_details` | `PATCH /v1/agent/orders` (`orderCode` opcional, en el cuerpo) |
| `rpc/agent_order_add_draft_items` | `POST /v1/agent/orders/items` (ídem) |
| `rpc/agent_conversation_handoff` | `POST /v1/agent/conversations/:id/handoff` |
| `functions/v1/create-order` (modo whatsapp) | `POST /v1/agent/draft/confirm` |
| `storage/v1/object/payment-proofs` + `rest/v1/order_payment_proofs` (4 nodos) | `POST /v1/agent/payment-proofs` (**un solo nodo**) |

Headers: se fueron `apikey` y `Authorization: Bearer <service_role>`; queda **`X-Api-Key: <la key del agente>`**. La única `Authorization` que sobrevive es la de Zernio, en `Send Zernio Reply`.

El detalle de qué cambió nodo por nodo está en [`fase8.md`](fase8.md).

---

## 6. Lo que queda afuera

- **Enviar mensajes a WhatsApp** sigue siendo de n8n (nodo de Zernio): la API guarda la conversación, no habla por el negocio.
- **`ai-bot-reply` y `whatsapp-webhook`** siguen viviendo en n8n; esta fase reemplaza lo que esas funciones hacían contra la base, no el ruteo del webhook.
- **Subida de comprobantes desde el panel** (hoy solo llegan por WhatsApp).
