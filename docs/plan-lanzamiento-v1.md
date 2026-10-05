# Toki — Plan de lanzamiento v1

**Fecha:** 2026-10-05 · **Versión:** 2 — incorpora las decisiones de Cacho del 2026-10-05 (§0) y pasa a un plan por fases (§6)
**Repos:** `toki-api`, `toki` (front), `toki-agents` · **Rama de trabajo:** `agente-v3` en los tres
**Objetivo:** salir esta semana con un flujo simple: el pedido se arma en la web, WhatsApp lo recibe e informa.
**Estado:** plan aprobado en sus decisiones; ninguna fase empezó.

---

## 0. Decisiones tomadas

| # | Tema | Decisión |
| --- | --- | --- |
| D1 | Dónde se pide | El cliente pide **sí o sí desde la web**. Sofi no arma pedidos por chat: indica que se pide desde el menú y pasa el link |
| D2 | Qué responde Sofi | Estado de los pedidos e información del negocio: envíos, medios de pago, ubicación, horarios, preguntas frecuentes |
| D3 | Creación del pedido | El agente crea el pedido **apenas llega el mensaje** de la web. Queda en `pending` |
| D4 | Pago por transferencia | El pedido se crea igual, con el pago pendiente. El pago se confirma cuando el local revisa el comprobante o lo verifica a mano en su billetera virtual |
| D5 | Datos que pide Sofi | Los del formulario web alcanzan (nombre, teléfono, entrega, dirección, pago). Lo único que se pide por WhatsApp es el comprobante cuando el pago es por transferencia |
| D6 | Negocio sin WhatsApp conectado | Por ahora se sigue el flujo de WhatsApp: el mensaje le llega al local y una persona carga el pedido a mano. El checkout directo queda anotado para revisar después (§9) |
| D7 | Agente en código | El agente pasa de n8n a código nativo en `toki-api` |
| D8 | Modelo | Se arranca con un modelo de OpenAI |

Sobre D3: el pedido lo crea el módulo del agente **en código**, sin pedirle al modelo que decida. El mismo mensaje da siempre el mismo resultado y un error del modelo no puede duplicar ni perder un pedido. La IA se usa para conversar (D2).

Siguen vigentes del plan del agente v3: el nombre **Sofi** y que el servidor decide precios, totales y stock. Queda sin efecto para la v1 tomar pedidos con el local cerrado: la web no toma pedidos fuera de horario y Sofi informa cuándo abren.

---

## 1. Alcance de la v1

| # | Qué hace | Cómo |
| --- | --- | --- |
| 1 | Indica que se pide por la web | Link del menú, una vez por conversación |
| 2 | Responde sobre el negocio | Con los datos del negocio y las preguntas frecuentes cargadas |
| 3 | Responde el estado de un pedido | Con el pedido activo de la conversación o por código |
| 4 | Recibe el mensaje del pedido web | Lo valida contra la API y crea el pedido en `pending` |
| 5 | Pide el comprobante | Solo con transferencia: pasa el total y los datos bancarios |
| 6 | Confirma | "El negocio ya recibió tu pedido", con código y link de seguimiento |
| 7 | Deriva | Reclamos, cambios y cancelaciones pasan a una persona del local |

**Afuera de la v1:** armar pedidos por chat, modificar y cancelar desde WhatsApp. Ese código ya existe en la API y queda sin usar.

---

## 2. Estado hoy

| Pieza | Producción | Rama `agente-v3` (local) |
| --- | --- | --- |
| API (Dokploy, `main`) | Migraciones hasta `0007`. Sin contexto v3, sin `/agent/catalog-orders`, sin modificar ni cancelar | Migraciones `0008`–`0012`, contexto v3, catálogo web → WhatsApp. 5 commits adelante de `main` |
| Front (`main`) | El checkout crea el pedido directo (`createOrder`) | El checkout prepara el mensaje de WhatsApp (`prepareCatalog`). 4 commits adelante |
| Agente | n8n, workflow `toki-whatsapp-lamelas` en `n8n.farmaciasya.cloud` | Mismo workflow, en el repo |

El workflow activo llama rutas que la API de producción no tiene y su prompt espera datos (`clock`, `menu`) que `main` no devuelve: hoy el agente funciona a medias.

**Verificado:** typecheck y lint de la API y del front, tests locales de los workflows. **Sin verificar:** tests de integración de la API (necesitan Postgres de prueba), pruebas reales por WhatsApp y el estado real del servidor.

---

## 3. Flujo

```text
Web: carrito + datos ─► POST /public/businesses/:slug/catalog-requests ─► mensaje con referencia
Cliente: envía el mensaje por WhatsApp al número del local

Zernio ─► POST /v1/webhooks/zernio (API) ─► guarda el mensaje ─► decide en código:
   ├─ trae "Referencia de solicitud: WEB-…"
   │      └─ valida y crea el pedido (pending)
   │             ├─ efectivo ─► "El negocio ya recibió tu pedido" + código + seguimiento
   │             └─ transferencia ─► total + datos bancarios + "mandame el comprobante"
   ├─ imagen o PDF, y hay un pedido por transferencia sin comprobante
   │      └─ guarda el comprobante ─► "Lo recibí; el negocio ya tiene tu pedido" + seguimiento
   └─ cualquier otro mensaje ─► IA (OpenAI) con los datos del negocio y del pedido activo
          tools: consultar_pedido, derivar_a_persona

Web: la pantalla de espera detecta que el pedido se creó, vacía el carrito y muestra el seguimiento
Panel: el pedido aparece en el tablero; con transferencia, marcado según tenga o no comprobante
```

### Estados del pedido y del pago

| Momento | Pedido (`status`) | Pago (`payment_status`) | Quién lo mueve |
| --- | --- | --- | --- |
| Llega el mensaje de la web | `pending` | `pending` | Agente, en código |
| Llega el comprobante | `pending` | `pending`, con comprobante `pending` de revisión | Agente, en código |
| El local revisa el comprobante o verifica en su billetera | sin cambio | `paid` | Persona del local, desde el panel |
| El local acepta el pedido | `confirmed` → `preparing` → … | sin cambio | Persona del local, desde el panel |

Sofi nunca dice que un pago está acreditado.

### Negocio sin WhatsApp conectado (D6)

El mensaje va al WhatsApp que el negocio cargó en Configuración. No hay agente: lo lee una persona y carga el pedido desde Venta manual. La web no puede mostrar "pedido recibido"; muestra que el local confirma por WhatsApp.

---

## 4. Qué dice Sofi en el pedido web

Textos armados en código con los datos reales. No los redacta el modelo.

| Caso | Mensaje |
| --- | --- |
| Efectivo | Resumen del pedido y total · "El negocio ya recibió tu pedido" · código · link de seguimiento |
| Transferencia, al crear | Resumen y total · alias, CBU/CVU, titular y banco · "Cuando transfieras, mandame el comprobante por acá" · código |
| Comprobante recibido | "Recibí el comprobante. El negocio ya tiene tu pedido y verifica el pago" · link de seguimiento |
| Reenvío del mismo mensaje | "Ese pedido ya está registrado" · código · seguimiento |
| Referencia vencida | "Pasaron más de 2 horas. Volvé al carrito y enviá el mensaje de nuevo" |
| Cambió un precio o el stock | Motivo concreto · "Volvé al carrito, revisá el total y enviá de nuevo". No se crea nada |
| Local cerrado | "Ahora estamos cerrados, abrimos …" . No se crea nada |

---

## 5. Agente en código nativo

Módulo nuevo en `toki-api`: `src/modules/bot/`. Reemplaza al workflow de n8n.

| Pieza | Qué es | Se reutiliza |
| --- | --- | --- |
| Webhook | `POST /v1/webhooks/zernio`, con el secreto compartido que hoy usa n8n (`X-Toki-Webhook-Key`). Responde 200 enseguida y procesa aparte | Lógica del nodo `normalizar` |
| Entrada | Resolver negocio, abrir conversación, guardar el mensaje. Los reintentos de Zernio no duplican | `resolveIntegration`, `upsertConversation`, `logMessage` |
| Decisión | Las tres ramas del §3 | `receiveCatalog`, `savePaymentProof` |
| IA | Cliente HTTP de OpenAI, sin SDK. Modelo por variable de entorno. Dos tools | `context`, `orderStatus`, `handoff` |
| Ráfagas | Espera corta por conversación y una sola respuesta. Pedido web y comprobante no esperan | — |
| Salida | Envío por Zernio y registro del mensaje saliente | `zernioFetch` |
| Pruebas | Tests con OpenAI y Zernio simulados; modo prueba que corre todo sin enviar WhatsApp | Escenarios de `toki-agents/tests` |

**Variables nuevas:** `OPENAI_API_KEY`, `AGENT_MODEL` (arranca con `gpt-4.1-mini`, el del workflow actual), `ZERNIO_WEBHOOK_SECRET`, `BOT_NATIVE_ENABLED`.

**Reglas del módulo:**

- El pedido web se crea aunque el bot esté apagado o una persona haya tomado la conversación. En esos casos se manda la confirmación fija y Sofi no conversa.
- Si OpenAI falla, después de un reintento se manda un texto fijo ("estoy con un problema para responder, probá en unos minutos") y el error queda en el log. No se deriva ni se promete que alguien va a contestar.
- Una imagen que no corresponde a ningún pedido por transferencia va a la IA como "el cliente mandó una imagen", sin guardarla como comprobante.

**Límite conocido:** la espera de ráfagas vive en memoria. Sirve con una sola instancia de la API, que es el caso actual; si la API se reinicia en medio de una espera, ese mensaje queda sin respuesta.

---

## 6. Plan de implementación gradual

Cada fase se puede desplegar sola y tiene vuelta atrás. Hasta la fase 6 los clientes siguen pidiendo como hoy (checkout directo), y hasta la fase 5 WhatsApp lo sigue atendiendo n8n.

**Modo de trabajo**, el de las fases anteriores: Claude escribe el código en el repo y corre typecheck y lint; Cacho corre los tests con base de datos, los deploys y las pruebas reales, y pega la salida.

| Fase | Qué sale | Producción cambia | Depende de |
| --- | --- | --- | --- |
| 0 | API al día (`agente-v3` en `main`) | API | — |
| 1 | Pedido web robusto | API | 0 |
| 2 | Agente nativo: pedido web y comprobante, sin IA | API (apagado) | 1 |
| 3 | Agente nativo: conversación con OpenAI | API (apagado) | 2 |
| 4 | Panel: bot, preguntas frecuentes y comprobantes | Front | 0 |
| 5 | Corte de WhatsApp: de n8n a la API | Zernio | 3 |
| 6 | Checkout web por WhatsApp | Front | 5 |
| 7 | Lanzamiento | — | 4 y 6 |

### Fase 0 — API al día

**Objetivo:** llevar a producción lo que ya está escrito, sin agregar nada, para separar el riesgo de las migraciones del resto.

| # | Tarea | Quién |
| --- | --- | --- |
| 0.1 | `npm run test:prepare && npm test` sobre `agente-v3`, con `DATABASE_URL_TEST` | Cacho |
| 0.2 | Backup de la base de producción (`scripts/backup-to-r2.sh`) | Cacho |
| 0.3 | Merge de `agente-v3` a `main` en `toki-api` y push. El entrypoint aplica `0008`–`0012` | Cacho |
| 0.4 | `scripts/smoke.sh`, `GET /v1/health` y revisar que el panel cargue pedidos | Cacho |

**Listo cuando:** tests en verde, health OK y el panel funciona igual que antes.
**Vuelta atrás:** redeploy del commit anterior. Las migraciones no borran nada: agregan tablas y columnas, reemplazan funciones que ya existían y cambian el nombre del bot de "Toki" a "Sofi" en los negocios que nunca lo tocaron.

### Fase 1 — Pedido web robusto

**Objetivo:** que el pedido web no pueda fallar ni perderse por causas ajenas al cliente.

| # | Tarea | Dónde | Detalle |
| --- | --- | --- | --- |
| 1.1 | Validar por referencia, no por texto exacto | `catalog/message.ts`, `catalog/service.ts` | Hoy se compara un hash del mensaje completo, que lleva espacios duros después del `$`. Si WhatsApp o Zernio los cambian, todo pedido se rechaza. La referencia es un identificador imposible de adivinar y vence a las 2 h; la respuesta repite el resumen y el total reales |
| 1.2 | Crear el pedido aunque el bot esté apagado o la conversación derivada | `receiveCatalog` | Hoy exige conversación en `open` |
| 1.3 | Sacar el bloqueo por borrador abierto | `receiveCatalog` | Un borrador viejo del agente anterior rechaza el pedido web. Se descarta solo |
| 1.4 | Número de destino | `prepareCatalog` | Con integración activa, el número conectado en Zernio; sin integración, el cargado en Configuración (D6). Hoy siempre usa el segundo |
| 1.5 | Estado de la solicitud | `public/routes.ts` | `GET …/catalog-requests/:requestId` → pendiente, pedido creado (con código) o vencida |
| 1.6 | El menú público informa si hay agente | `public/service.ts` | Para que la web sepa si puede esperar la confirmación automática |
| 1.7 | Tests y `docs/api.md` | `test/catalog-orders.test.ts` | Casos nuevos: texto alterado, bot apagado, conversación derivada, borrador viejo, sin integración |

**Listo cuando:** tests en verde y deploy hecho. El front y n8n no cambian.
**Vuelta atrás:** redeploy del commit anterior. Sin migraciones.
**A verificar en esta fase:** qué guarda Zernio como número de la cuenta conectada (`whatsapp_integrations.phone_number`); si no es un teléfono utilizable, 1.4 usa el de Configuración y el panel avisa cuando no coinciden.

### Fase 2 — Agente nativo: pedido web y comprobante

**Objetivo:** el camino del pedido completo en código, sin IA. Se despliega apagado.

| # | Tarea | Detalle |
| --- | --- | --- |
| 2.1 | Webhook y lectura del mensaje de Zernio | Secreto compartido, respuesta inmediata, proceso aparte |
| 2.2 | Entrada | Negocio, conversación, registro del mensaje, descarte de duplicados |
| 2.3 | Rama del pedido web | `receiveCatalog` + textos del §4 |
| 2.4 | Rama del comprobante | Imagen o PDF con pedido por transferencia sin comprobante → `savePaymentProof` + texto del §4 |
| 2.5 | Envío por Zernio y registro del saliente | Varias burbujas con intervalo corto |
| 2.6 | Interruptor `BOT_NATIVE_ENABLED` y modo prueba | Apagado, el webhook responde 200 y no hace nada |
| 2.7 | Tests | Efectivo, transferencia + comprobante, reenvío, vencido, precio cambiado, bot apagado, mensaje repetido por Zernio |

**Listo cuando:** tests en verde y, en modo prueba contra producción, un pedido de prueba se crea y devuelve los textos correctos sin enviar WhatsApp.
**Vuelta atrás:** `BOT_NATIVE_ENABLED=false`. Zernio sigue apuntando a n8n.

### Fase 3 — Agente nativo: conversación

**Objetivo:** Sofi responde preguntas con OpenAI.

| # | Tarea | Detalle |
| --- | --- | --- |
| 3.1 | Cliente de OpenAI con tools | `OPENAI_API_KEY`, `AGENT_MODEL`, tiempo máximo y un reintento |
| 3.2 | Prompt | Corto: informa y no vende por chat. Para pedir, link del menú una vez. Datos solo del contexto. Mensajes de 1 a 3 líneas |
| 3.3 | Tools | `consultar_pedido` y `derivar_a_persona` (crea el caso con motivo y resumen) |
| 3.4 | Contexto | Reloj, datos del local, medios de pago, preguntas frecuentes, pedido activo e historial. De la carta, solo categorías y link |
| 3.5 | Ráfagas | Espera por conversación y descarte si llegó otro mensaje |
| 3.6 | Respaldo | Si OpenAI falla, texto fijo de disculpa y error en el log |
| 3.7 | Tests y suite | Tests con OpenAI simulado; suite reducida en modo prueba con el modelo real |

**Listo cuando:** la suite reducida pasa dos corridas seguidas sin fallas repetidas.
**Vuelta atrás:** la misma de la fase 2.

### Fase 4 — Panel

**Objetivo:** que el negocio pueda manejar el bot y ver los pagos. Puede hacerse en paralelo a las fases 2 y 3.

| # | Tarea | Dónde | Detalle |
| --- | --- | --- | --- |
| 4.1 | "Bot con IA" real | `routes/SettingsPages.tsx` | Hoy es una maqueta: no carga ni guarda. Conectar a `/v1/settings/bot` (activo, nombre, tono, mensaje al derivar, permitir derivación) |
| 4.2 | Preguntas frecuentes | misma pantalla | Alta, edición, activar y borrar. La API y el cliente HTTP ya existen |
| 4.3 | Comprobante en la tarjeta del tablero | `components/orders/OrderCard.tsx`, `GET /orders` | "Esperando comprobante" / "Comprobante recibido". Hoy solo se ve al abrir el pedido |
| 4.4 | Aviso de número distinto | Configuración de WhatsApp | Si el número cargado a mano no coincide con el conectado |

**Listo cuando:** un cambio en la pantalla del bot se refleja en la respuesta del modo prueba.
**Vuelta atrás:** redeploy del front anterior.

### Fase 5 — Corte de WhatsApp

**Objetivo:** que el agente nativo atienda WhatsApp real.

| # | Tarea | Quién |
| --- | --- | --- |
| 5.1 | Cargar `OPENAI_API_KEY` y `ZERNIO_WEBHOOK_SECRET` en Dokploy y poner `BOT_NATIVE_ENABLED=true` | Cacho |
| 5.2 | En Zernio, cambiar el webhook de `n8n.farmaciasya.cloud/webhook/toki-whatsapp-lamelas` a `toki-api.koistudio.com.ar/v1/webhooks/zernio`, con el encabezado del secreto | Cacho |
| 5.3 | Desactivar el workflow en n8n. Un solo receptor activo | Cacho |
| 5.4 | Pruebas 7 a 11 del §8 con un negocio de prueba y un teléfono real | Cacho |
| 5.5 | Ajustes de prompt y de textos según las pruebas | Claude |

**Listo cuando:** las pruebas 7 a 11 pasan.
**Vuelta atrás:** devolver el webhook de Zernio a n8n y reactivar el workflow.
**A verificar antes:** si el webhook de Zernio es uno por cuenta conectada o uno para todo el equipo. Si es uno solo, el corte es para todos los negocios a la vez.

### Fase 6 — Checkout web por WhatsApp

**Objetivo:** que los clientes pidan por el flujo nuevo. Es el momento en que cambia la experiencia del cliente final.

| # | Tarea | Dónde | Detalle |
| --- | --- | --- | --- |
| 6.1 | Cerrar el circuito | `routes/CheckoutPage.tsx` | Con 1.5: consultar el estado al volver a la página, vaciar el carrito y mostrar el seguimiento. Sin agente (1.6): "el local te confirma por WhatsApp" |
| 6.2 | Precio por producto con extras | `routes/CheckoutPage.tsx` | El carrito y el resumen muestran `precio × cantidad` sin los recargos; el subtotal sí los suma |
| 6.3 | Ocultar "Mercado Pago · Próximamente" | `routes/CheckoutPage.tsx` | — |
| 6.4 | Merge de `agente-v3` a `main` en el front y deploy | — | Cacho |
| 6.5 | Pruebas 1 a 6 y 12 del §8 | — | Cacho |

**Listo cuando:** las pruebas pasan con un teléfono real.
**Vuelta atrás:** redeploy del front anterior, que vuelve al checkout directo.

### Fase 7 — Lanzamiento

| # | Tarea |
| --- | --- |
| 7.1 | Alta del primer negocio: carta, horarios, medios de pago, WhatsApp conectado, preguntas frecuentes |
| 7.2 | Un pedido real de punta a punta con ese negocio |
| 7.3 | Primeros días: revisar el log de errores del agente y las conversaciones derivadas |
| 7.4 | Actualizar `plan-implementacion.md` y este documento con lo que quedó hecho |

---

## 7. Calendario

| Día | Fases | Notas |
| --- | --- | --- |
| Lun 5 (tarde) | 0 (tests y backup), código de la 1 | El deploy de la 0 se hace con los tests en verde |
| Mar 6 | Deploy de 0 y 1. Fase 2 | — |
| Mié 7 | Fase 3. Fase 4 | — |
| Jue 8 | Fase 5 | Día de pruebas reales por WhatsApp |
| Vie 9 | Fases 6 y 7 | — |

Es un calendario justo. Si algo se atrasa, se recorta en este orden: 4.3, 4.4, 6.3, y la suite de 3.7 se reemplaza por las pruebas reales de la fase 5. No se recortan las fases 0, 1 y 2 ni la 4.1.

---

## 8. Pruebas reales

Con un negocio de prueba y un teléfono real:

1. Pedido en efectivo con retiro: llega la confirmación con código y seguimiento, y el pedido aparece una sola vez en el tablero, en `pending`.
2. Pedido por transferencia con delivery: llegan los datos bancarios; el pedido ya está en el tablero con el pago pendiente; al mandar la foto, se guarda el comprobante y llega la confirmación.
3. Reenviar el mismo mensaje: no crea otro pedido.
4. Mensaje editado antes de enviar: el pedido creado es el del carrito y la respuesta muestra el total real.
5. Solicitud vencida (más de 2 h) y precio cambiado entre la web y el envío: se rechaza con un motivo claro y no crea nada.
6. Productos con extras y cupón: total, stock y uso del cupón una sola vez.
7. "¿Tienen delivery?", "¿hasta qué hora?", "¿dónde están?", "¿aceptan transferencia?": respuestas con datos reales.
8. "Quiero una pizza": indica que se pide por la web y pasa el link; no arma el pedido.
9. "¿Cómo va mi pedido?" con y sin pedido activo.
10. Tres mensajes seguidos: una sola respuesta.
11. Bot apagado y conversación tomada por una persona: Sofi no conversa, pero el pedido web se crea igual.
12. En la web: la pantalla de espera pasa a "pedido recibido" y el carrito se vacía.

---

## 9. Anotado para después del lanzamiento

| # | Tema | Nota |
| --- | --- | --- |
| P1 | **Negocio sin WhatsApp conectado** (D6) | Revisar si el checkout crea el pedido directo en vez de depender de la carga manual. El alta directa (`POST …/orders`) sigue existiendo en la API |
| P2 | Limpieza de solicitudes vencidas | Guardan nombre, teléfono y dirección y hoy no se borran nunca. Conviene hacerlo en las primeras semanas |
| P3 | Envío y retiro configurables | No existe "hace envíos sí/no": el checkout siempre ofrece las dos opciones y Sofi solo puede responderlo si está en las preguntas frecuentes |
| P4 | Aprobar el comprobante marca el pedido como pagado | Hoy son dos pasos separados en el panel |
| P5 | Recordatorio de comprobante | Si pasan N minutos sin comprobante, Sofi lo vuelve a pedir |
| P6 | Pausar el bot si el local responde desde su teléfono | La conexión por defecto permite contestar desde la app de WhatsApp |
| P7 | Audios | v1: Sofi pide que lo escriban. Transcribir es una llamada más a OpenAI |
| P8 | Campo "WhatsApp" del formulario web | El número ya viene de la conversación |
| P9 | Firma del webhook | Hoy es un secreto compartido en un encabezado |
| P10 | Comparación de modelos | Plan del agente v3, §9 |
| P11 | Pedidos, cambios y cancelaciones por chat | Código existente en la API; rutas viejas a limpiar (B14 del plan v3) |
| P12 | Mercado Pago | — |
