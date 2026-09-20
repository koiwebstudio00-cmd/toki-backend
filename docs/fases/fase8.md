# Fase 8 — El agente de WhatsApp contra la API propia

**Ramas:** `fase8` (sale de `fase7` en `toki-api` y de `main` en `toki-agents`) · **Fecha:** 2026-09-20 · **Tests:** 237 en verde

La fase 4 construyó las rutas `/v1/agent/*` pero dejó el workflow de n8n apuntando a Supabase, a la espera de la URL del backend. Esta fase lo recablea de verdad y cierra los huecos que aparecieron al hacerlo.

---

## 1. Qué se revisó

`toki-agents/n8n/toki-agent-v2.json`, nodo por nodo: 47 nodos, todos contra PostgREST, el Storage de Supabase y la Edge Function `create-order`.

El recableado no era solo cambiar URLs. **Tres nodos leían formas de respuesta que la API no tenía**, y dos rutas estaban diseñadas para un caso que el agente casi nunca usa. Eso se arregló en el backend antes de tocar el JSON.

### Huecos que aparecieron y se cerraron

| Nodo del workflow | Qué necesitaba | Qué se hizo |
| --- | --- | --- |
| `Revisar Alta` | La marca temporal del mensaje recién guardado, para saber contra qué comparar en el debounce de ráfagas | `POST /agent/messages` ahora devuelve `{ duplicate: false, id, createdAt }` |
| `Buscar Mensajes Nuevos` | "¿entró otro mensaje del cliente después de las HH:MM:SS?" | Ruta nueva: `GET /agent/conversations/:id/messages?businessId=&after=&direction=&limit=` → `{ data, count }` |
| `Estado Conversacion` | Releer el `status` justo antes de enviar | Ruta nueva: `GET /agent/conversations/:id?businessId=` → `{ id, contactId, phone, status, handoffReason, lastMessageAt }` |

Sin esas tres, el workflow quedaba sin el buffer de ráfagas (el bot contestaría tres veces a tres mensajes seguidos) y sin la guarda que lo calla cuando una persona del negocio entró a responder.

### Dos correcciones de diseño

**`orderCode` pasa de la URL al cuerpo, y es opcional.** Las funciones SQL `agent_order_update_details` y `agent_order_add_draft_items` tratan un `p_order_code` nulo como "el último pedido editable de este contacto" — que es lo que el cliente quiere decir casi siempre ("cambiame la dirección"). Con el código en la URL ese caso no se podía expresar:

```
PATCH /v1/agent/orders/:orderCode   →   PATCH /v1/agent/orders     { orderCode?, ... }
POST  /v1/agent/orders/:orderCode/items → POST /v1/agent/orders/items { orderCode? }
```

**`paymentMethod` volvió a aceptar `mercadopago`.** El enum de Zod se había quedado en `cash | transfer`, pero la base tiene los tres valores y la función SQL verifica si el negocio lo tiene habilitado, devolviendo un motivo legible. Con el enum recortado, un cliente que elegía Mercado Pago provocaba un `400` de validación que el agente no sabe explicar, en lugar de un `{ ok: false, error: "..." }` que sí le cuenta al cliente. Cubierto por un test.

## 2. El workflow: 47 nodos → 43

### El comprobante de pago: 4 nodos a 1

Antes el workflow hacía el trabajo a mano: `Descargar Adjunto` (bajaba el archivo de Zernio) → `Normalize Storage Path` (armaba la key con string concat) → `Subir Comprobante` (subía el binario al Storage) → `Hay Pedido?` (decidía si insertar la fila).

Ahora es un solo nodo, `Guardar Comprobante` → `POST /v1/agent/payment-proofs`, y la API descarga, valida el tipo (imagen o PDF, máx. 10 MB), sube a R2 privado, resuelve el pedido y guarda la fila, todo idempotente por `providerMessageId`.

Que la key del objeto la arme el servidor no es cosmético: era el único lugar donde n8n decidía dónde se guarda un archivo privado de un negocio.

### Cambios nodo por nodo

| Nodo | Cambio |
| --- | --- |
| *(nombre del workflow)* | "(Zernio + Supabase)" → "(Zernio + API Toki)" |
| `Load Integration` | `GET /v1/agent/integrations/by-account/:accountId` |
| `Attach Business` | Lee `$json.business` (objeto) en vez de `rows[0].businesses`. Con `neverError`, un 404 llega como `{ error: {...} }`: la guarda mira si vino el negocio |
| `Upsert Conversation` | `POST /v1/agent/conversations/upsert`, cuerpo camelCase |
| `Normalize Conversation` | Lee `conversationId` de un objeto plano |
| `Log Inbound Message` | `POST /v1/agent/messages`, cuerpo camelCase |
| `Revisar Alta` | `duplicate === true` en vez de leer el código `23505` de Postgres; `createdAt` en vez de `created_at` |
| `Buscar Mensajes Nuevos` | Ruta nueva, con `after` + `direction=inbound&limit=1` |
| `Contar Nuevos` | `count > 0` en vez de "¿el array trae algo con `id`?" |
| `Cargar Contexto` | Pasa a `GET`. El jsonb que devuelve es el mismo, así que **`Preparar Turno` no se tocó** |
| `Descargar Adjunto`, `Normalize Storage Path`, `Subir Comprobante`, `Hay Pedido?` | **Eliminados** |
| `Guardar Comprobante` | `POST /v1/agent/payment-proofs` con `mediaUrl`; `Tiene Adjunto? [0]` lo alimenta directo |
| `Build Reply` | La rama de adjunto usa la respuesta de la API (`ok`, `orderCode`) en vez de adivinar con el pedido activo del contexto: la API resuelve el pedido aunque no hubiera uno "activo", y rechaza lo que no es comprobante |
| Las 11 tools | URLs, métodos y cuerpos nuevos. **Los nombres y las descripciones no cambiaron**: el prompt del agente quedó intacto |
| `Estado Conversacion` | Ruta nueva. `$json.status` sigue funcionando (ahora es un objeto, antes un array de una fila) |
| `Log Outbound Message` | `POST /v1/agent/messages` |
| `Notas` | Reescrita: instrucciones de la versión API |

### Las tools

| Tool | Antes | Ahora |
| --- | --- | --- |
| `buscar_productos` | `rpc/agent_search_products` | `GET /v1/agent/products/search` |
| `ver_producto` | `rpc/agent_product_detail` | `GET /v1/agent/products/:id` |
| `buscar_faq` | `rpc/agent_search_faq` | `GET /v1/agent/faq/search` |
| `consultar_pedido` | `rpc/agent_order_status` | `GET /v1/agent/orders/status` |
| `agregar_al_pedido` | `rpc/agent_draft_add_item` | `POST /v1/agent/draft/items` |
| `quitar_del_pedido` | `rpc/agent_draft_remove_item` | `DELETE /v1/agent/draft/items/:itemId` |
| `datos_del_pedido` | `rpc/agent_draft_set_details` | `PATCH /v1/agent/draft` |
| `modificar_datos_pedido` | `rpc/agent_order_update_details` | `PATCH /v1/agent/orders` |
| `sumar_al_pedido` | `rpc/agent_order_add_draft_items` | `POST /v1/agent/orders/items` |
| `confirmar_pedido` | `functions/v1/create-order` | `POST /v1/agent/draft/confirm` |
| `derivar_a_persona` | `rpc/agent_conversation_handoff` | `POST /v1/agent/conversations/:id/handoff` |

### Autenticación

Se fueron **todas** las keys de Supabase. Cada nodo que pega a la API lleva un único header `X-Api-Key: PEGAR_TOKI_AGENT_API_KEY_AQUI`. La única `Authorization` que queda es la de Zernio, en `Send Zernio Reply` — y ya no hace falta en `Descargar Adjunto`, porque la descarga la hace el servidor con su propia `ZERNIO_API_KEY`.

El servidor guarda **solo el SHA-256** de la key (`AGENT_API_KEY_SHA256`). La key en claro vive únicamente en n8n.

## 3. Lo que no cambió (a propósito)

- **El prompt del agente.** Los nombres de las tools, sus descripciones y el system message son idénticos. Las respuestas JSON son el mismo jsonb que devolvían las RPC.
- **`Preparar Turno`.** Consume `agent_context`, que no cambió de forma.
- **Las guardas.** Dedup por `providerMessageId`, buffer de ráfagas de 6 s, `Bot Activo?` y `Bot Sigue Activo?` siguen igual, solo que leyendo respuestas de la API.
- **El path del webhook.** Sigue siendo el mismo string largo y aleatorio; no hace falta tocar Zernio si ya estaba configurado contra este workflow.

## 4. Tests

```
237 en verde (14 archivos) · lint, typecheck y build limpios
```

Cinco tests nuevos en `test/agent.test.ts` (37 en ese archivo):

- `POST /messages` devuelve `createdAt`
- `GET /conversations/:id/messages` detecta un mensaje posterior a `after`
- `GET /conversations/:id` devuelve el estado
- ninguna de las dos responde para una conversación de otro negocio (404)
- `PATCH /draft` acepta `mercadopago` cuando el negocio lo tiene habilitado

Y el que cubre el caso que motivó mover `orderCode` al cuerpo: *"sin código toma el último pedido del contacto"*.

---

## 5. Cómo probarlo

### Importar el workflow

1. En n8n: **Workflows → Import from File** → `toki-agents/n8n/toki-agent-v2.json`.
2. Buscar y reemplazar `https://api.tudominio.com` por la URL real de la API.
3. Reemplazar `PEGAR_TOKI_AGENT_API_KEY_AQUI` por la key del agente (la que generaste en el paso 1 de [`deploy.md`](../deploy.md); en el servidor solo vive su SHA-256).
4. Reemplazar `PEGAR_ZERNIO_API_KEY_AQUI` en `Send Zernio Reply`.
5. Cargar las credenciales de OpenAI en `OpenAI Chat Model`.

### Probar las rutas a mano, sin n8n

Con la API levantada y la key del agente en `$KEY`:

```bash
API=http://localhost:3000
KEY=<la key en claro del agente>
H="X-Api-Key: $KEY"

# 1. La cuenta de Zernio resuelve un negocio
curl -s -H "$H" "$API/v1/agent/integrations/by-account/<accountId>" | jq

BIZ=<businessId>

# 2. Conversación y mensaje entrante
CONV=$(curl -s -X POST "$API/v1/agent/conversations/upsert" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"contactId\":\"5491100000000\"}" | jq -r .conversationId)

curl -s -X POST "$API/v1/agent/messages" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\",\"direction\":\"inbound\",\"content\":\"hola\",\"providerMessageId\":\"evt-1\"}" | jq
# → { "duplicate": false, "id": "...", "createdAt": "..." }   ← guardá el createdAt

# El mismo evento otra vez: el webhook se reintenta y no tiene que duplicar
curl -s -X POST "$API/v1/agent/messages" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\",\"direction\":\"inbound\",\"content\":\"hola\",\"providerMessageId\":\"evt-1\"}" | jq
# → { "duplicate": true }

# 3. El debounce de ráfagas: ¿entró algo después?
AFTER=<el createdAt de arriba>
curl -s -H "$H" "$API/v1/agent/conversations/$CONV/messages?businessId=$BIZ&after=$AFTER&direction=inbound&limit=1" | jq
# → { "data": [], "count": 0 }  ← esta ejecución es la última, contesta

# 4. La guarda de handoff
curl -s -H "$H" "$API/v1/agent/conversations/$CONV?businessId=$BIZ" | jq .status
curl -s -X POST "$API/v1/agent/conversations/$CONV/handoff" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"reason\":\"queja\"}" | jq
curl -s -H "$H" "$API/v1/agent/conversations/$CONV?businessId=$BIZ" | jq .status
# → "handoff"   ← con esto el workflow no envía

# 5. Pedido confirmado sin código: el último editable del contacto
curl -s -X PATCH "$API/v1/agent/orders" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"conversationId\":\"$CONV\",\"deliveryAddress\":\"Rivadavia 100\"}" | jq

# 6. Aislamiento: la conversación de otro negocio no existe
curl -s -o /dev/null -w '%{http_code}\n' -H "$H" "$API/v1/agent/conversations/$CONV?businessId=<otro-business-id>"
# → 404
```

### De punta a punta por WhatsApp

Con el workflow activo y el bot habilitado en el panel:

1. **"hola"** → saluda una sola vez.
2. **"que tienen?"** → nombra productos reales con precios reales (si inventa uno, la tool no se llamó).
3. **Tres mensajes seguidos y rápidos** ("hola" / "queria pedir" / "una muzza") → **una sola respuesta**, que contempla los tres. En n8n tienen que verse tres ejecuciones y dos muriendo en `Es El Ultimo?`.
4. **Armar un pedido** hasta el resumen y confirmar → llega al tablero en tiempo real con el código `TK-XXXXXX`.
5. **"cambiame la dirección a X"** sin dar el código → tiene que tomar ese pedido (esto es lo que prueba el `orderCode` opcional).
6. **Mandar una foto** como comprobante → responde nombrando el pedido, y en el panel aparece el comprobante. Mandar la misma foto otra vez no tiene que duplicarlo.
7. **"quiero hablar con alguien"** → deriva, avisa, y **deja de contestar** los mensajes siguientes.
8. **Tomar la conversación desde el panel** mientras el cliente escribe → el bot se calla (`Bot Sigue Activo?`).

---

## 6. Qué queda pendiente

- **Validar `X-Zernio-Signature`.** n8n entrega el body ya parseado y la firma necesita los bytes crudos. Mientras tanto la protección es que el path del webhook es largo y aleatorio. Se resuelve el día que el webhook entre por la API en vez de por n8n.
- **Las columnas heredadas de Meta** en `whatsapp_integrations` (hallazgo H3): se limpian después del corte.
