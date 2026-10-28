# Agente de Toki por WhatsApp

Implementación local completada el 8 de octubre de 2026. Conexión directa a OpenAI y pruebas iniciales reales verificadas el 10 de octubre de 2026. Falta el piloto completo de WhatsApp/Zernio/R2 y el despliegue. No se modificó la base de producción ni se enviaron mensajes reales durante el desarrollo.

## Qué hace

Cada negocio configura nombre, tono, instrucciones, información, FAQs y permisos desde Configuración → Asistente. El modelo redacta según la conversación; no hay una tabla de respuestas predefinidas. Consulta el catálogo y los pedidos del contacto, arma borradores, solicita confirmación para crear/cambiar/cancelar pedidos, guarda comprobantes sin acreditar pagos, registra datos para devoluciones y deriva al equipo.

La previsualización del panel es un entorno de consultas, sin escrituras ni envío a clientes. WhatsApp usa un registro separado de herramientas operativas. Precios, opciones, stock, condiciones del pedido y permisos son decisiones del servidor. El alcance comercial es el que ya soporta Toki: venta de productos y servicios cargados en el catálogo; no agrega agenda de turnos ni reservas.

## Recorrido

1. Zernio entrega `message.received` al webhook firmado. Se comprueba HMAC-SHA256 sobre los bytes originales, se resuelve una única cuenta activa y se guardan evento, mensaje y turno en una transacción.
2. La API responde sin llamar al modelo. La cola PostgreSQL espera seis segundos para agrupar mensajes cercanos. El turno más reciente recibe hasta 30 mensajes de contexto; los anteriores quedan omitidos.
3. El worker reclama un turno por conversación y reserva presupuesto diario por negocio. Ejecuta `ToolLoopAgent`, con hasta cinco pasos, 1200 tokens de salida por paso, 16 herramientas y 30 segundos de generación.
4. Las escrituras tienen un registro persistente por mensaje, herramienta y argumentos. Los permisos, canal, último mensaje y atención humana se verifican de nuevo antes de cada herramienta.
5. Crear, modificar y cancelar pedidos prepara una propuesta de diez minutos. El resumen se calcula con el mismo código transaccional que ejecutará el cambio. Toki agrega botones firmados. Solo un `button_reply` del mismo contacto/conversación puede aceptarla. Un “sí” escrito, una reacción o texto generado por el modelo no ejecutan operaciones.
6. Al aceptar se recalcula y compara la propuesta dentro de la transacción. Si cambió el pedido, un precio o las condiciones incluidas, se pide una nueva confirmación. El borrador se bloquea al confirmar; las excepciones revierten toda la transacción.
7. La respuesta completa se guarda antes del envío. Se revalidan conversación, integración y ventana de WhatsApp. Se envía con `Idempotency-Key` estable y se guarda el identificador del proveedor. Los errores `message.failed` se reconcilian aunque lleguen antes de la respuesta HTTP del envío.

El modelo recibe la imagen del mensaje actual como bytes. Con OpenAI directo, las notas de voz se transcriben antes de pasarlas como mensaje del cliente a Responses; con Gateway se conservan como entrada de audio y el modelo debe soportar esa modalidad. El modelo de conversación debe soportar imágenes y llamadas a herramientas. Un formato o modalidad no soportada deja el turno para revisión. Los PDF se reciben como archivos/comprobantes; no hay extracción documental general. Las descargas requieren HTTPS, origen y ruta de medios de Zernio autorizados, sin redirecciones y con límite durante la lectura (5 MiB para entrada al modelo, 10 MiB para comprobantes). El modelo nunca elige una URL de descarga ni un negocio/contacto.

## Configuración del servidor

| Variable | Uso |
| --- | --- |
| `OPENAI_API_KEY` | Clave de OpenAI, exclusivamente en el servidor. |
| `OPENAI_MODEL` | ID del modelo de OpenAI. Sin valor por defecto; piloto inicial: `gpt-5.4-mini`. |
| `OPENAI_TRANSCRIPTION_MODEL` | Transcripción de notas de voz; por defecto `gpt-transcribe`. |
| `AI_GATEWAY_API_KEY` | Credencial de AI Gateway, como alternativa a OpenAI directo. |
| `AI_GATEWAY_MODEL` | ID `provider/model` elegido del catálogo vigente. No tiene valor por defecto. |
| `ZERNIO_API_KEY` | Key del equipo que administra las cuentas de WhatsApp. |
| `ZERNIO_WEBHOOK_SECRET` | Secreto compartido configurado en la suscripción de Zernio. Generarlo aleatorio y largo. |
| `AGENT_WORKER_ENABLED` | `false` por defecto. `true` inicia el worker junto a la API; exige un proveedor/modelo completo, `ZERNIO_API_KEY` y `ZERNIO_WEBHOOK_SECRET`. |
| `AGENT_WORKER_CONCURRENCY` | 4 por defecto; 1–16 turnos simultáneos por proceso, en distintas conversaciones. Coordina también entre réplicas mediante PostgreSQL. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_PRIVATE` | Almacenamiento privado de comprobantes. La herramienta nativa rechaza operar sin credenciales, incluso cuando otros servicios usan almacenamiento simulado en desarrollo. |

Si se define `OPENAI_API_KEY` o `OPENAI_MODEL`, ambos son obligatorios y tienen prioridad sobre Gateway. No hay fallback automático ante errores ni configuración parcial. Para elegir Gateway, dejar ambos campos de OpenAI vacíos. OpenAI usa Responses con `store=false`, historial administrado por Toki y validación Zod de herramientas; no se activa el modo estricto del proveedor porque los schemas existentes tienen campos opcionales.

Se conservan las variables habituales de Toki (`DATABASE_URL`, `DATABASE_URL_MIGRATE`, `JWT_SECRET`, CORS, URL del panel y autenticación del flujo anterior). Nunca usar variables `VITE_*` para secretos. El panel muestra preparación de configuración, no verifica saldo, conectividad o compatibilidad del modelo.

El worker requiere un proceso Node persistente (Dokploy/Docker actual). No usar el arranque en una función efímera. Configurar un período de cierre del contenedor de al menos 60 segundos; SIGTERM detiene nuevos trabajos, cancela el modelo y espera tareas activas antes de cerrar la BD. Una caída forzada deja registros recuperables.

### Si el chat devuelve 503

Una clave de ejemplo como `tu_clave` no habilita el agente. Configurá una clave real en `OPENAI_API_KEY` del archivo `toki-backend/.env`, mantené `OPENAI_MODEL` configurado y reiniciá la API. No publiques ni pegues la clave en chats, logs o variables `VITE_*`.

Si el proveedor rechaza una clave con HTTP 401, el panel indica que hay que revisar la clave del servidor; la API mantiene HTTP 503 porque la sesión del usuario de Toki sigue siendo válida. Nunca devuelve el error crudo del proveedor, que podría incluir credenciales. Una clave presente no garantiza permisos, saldo o disponibilidad del modelo: validar con una consulta real después de configurarla.

## Activación y regreso al flujo anterior

1. Aplicar migraciones `0013` a `0016` con el procedimiento normal de despliegue. Las tablas internas tienen RLS y acceso exclusivo de `service_role`; las rutas del panel exigen owner/admin y validan membresía y negocio.
2. Cargar `OPENAI_API_KEY` y `OPENAI_MODEL` (o el par de Gateway) y reiniciar la API para probar consultas en el panel. Una vez configurado Zernio, reiniciar con `AGENT_WORKER_ENABLED=true`.
3. En Zernio crear una suscripción a `https://<api>/v1/webhooks/zernio` para `message.received`, `message.sent`, `message.failed`, `conversation.control_changed`, con el mismo `secret`. Acotar `accountIds` o `profileIds` del piloto. Acepta `webhook.test`; no es un mensaje de cliente.
4. Conectar el número desde Configuración → WhatsApp. Completar la configuración del asistente, probar sus consultas en el panel y habilitar “Usar este asistente para atender por WhatsApp”. Cada negocio conserva `engine=legacy` hasta esta activación explícita.
5. Probar con el número del equipo antes de incorporar clientes reales. El flujo anterior recibe `botEnabled=false` para un negocio nativo; sus herramientas HTTP rechazan operaciones para ese negocio aunque hubiese un workflow en curso.
6. Para regresar al flujo anterior, desactivar la opción de atención del asistente nativo. Se omiten turnos en cola/respuestas listas y vencen propuestas pendientes. No se repiten mensajes antiguos. Para pausar toda atención, usar el control general del asistente; cambiar el motor puede habilitar nuevamente el workflow anterior si continúa conectado.

## Operación y recuperación

Configuración → Asistente → Actividad reciente muestra los últimos 40 turnos con enlaces a sus conversaciones. Estados: `queued`, `running`, `ready`, `sending`, `sent`, `skipped`, `failed`, `uncertain`. `sent` significa aceptado por la API de envío; no garantiza lectura ni entrega final al teléfono. Un webhook de fallo lo convierte en `failed`.

El límite diario, inicialmente 500 turnos, se reserva bajo bloqueo del negocio y se renueva a las 00:00 UTC (21:00 Argentina). Al agotarlo se pausa esa conversación para atención humana. La previsualización tiene sus propios límites por usuario/proceso y no consume esta cuota. No es una cuota monetaria del proveedor: configurar también su presupuesto externo.

Los turnos `running`/`sending` con más de dos minutos se marcan fallidos/inciertos; no vuelven a ejecutarse al reiniciar. Una operación cuyo resultado no pudo registrarse queda bloqueada (`agent_actions.started/uncertain`). La transacción comercial y su registro son separados: se garantiza como máximo un intento por identidad, no una garantía distribuida de ejecución exactamente una vez.

Ante un envío incierto, revisar la conversación en WhatsApp/Zernio y el pedido en Toki. No reintentar un envío por timeout: Zernio solo conserva idempotencia para respuestas exitosas y puede haber aceptado el mensaje antes de fallar. El panel permite registrar el resultado de la revisión con una nota y el usuario responsable, desbloqueando los registros sin repetir operaciones. Espera dos minutos para evitar una revisión mientras sigue una operación. Luego se retoma el asistente desde la conversación. El reintento está permitido únicamente si no hubo acciones ni respuesta preparada, el mensaje sigue siendo el último y la conversación volvió a estar abierta.

Se respetan `metadata.standby`, toma de control por otra aplicación y mensajes humanos (`sentVia=human`, `source=whatsapp_business_app` o `meta_business_agent`). Una derivación hecha por el propio agente puede emitir su aviso final, si todavía no hubo respuesta humana. No se envían plantillas automáticamente fuera de la ventana de atención. Respuestas mayores a 4096 caracteres, o confirmaciones mayores a 1024 incluyendo botones, quedan para revisión en lugar de enviar un resumen incompleto.

No registrar cuerpos de webhooks, memoria de prueba, adjuntos ni errores completos del proveedor. Los eventos de deduplicación se conservan 30 días; mensajes, acciones y propuestas se conservan como historial operativo y se eliminan por cascada al borrar el negocio/conversación.

## Validación

Las pruebas usan PostgreSQL real aislado, el rol de aplicación y modelos/proveedores simulados. Cubren firmas, deduplicación, ráfagas, competencia entre workers, herramientas sobre pedidos reales de prueba, permisos revocados, separación de contactos y negocios, decisiones firmadas, vencimiento/rechazo, cambio de precios, comprobantes privados, handoff, cuotas, fallos ambiguos, caída del worker, recibos de entrega anticipados y revisión administrativa.

```sh
npm run lint
npm run typecheck
npm run build
# DATABASE_URL_TEST debe apuntar exclusivamente a una base de pruebas.
npm test
```

Prueba final con credenciales reales (pendiente): recepción de texto, imagen, PDF y audio; respuesta natural con los tonos elegidos; catálogo/precios y correcciones en varios mensajes; crear/modificar/cancelar con aceptación/rechazo; comprobante guardado en R2 sin marcar pago; derivación y retoma; dos negocios y dos contactos; pausa; estado de entrega y consumo observado en el proveedor. Comparar cada pedido con lo efectivamente acordado. No dar el piloto por validado solo porque la key fue aceptada.

Fuentes del contrato: [webhooks y firmas](https://docs.zernio.com/webhooks), [eventos de inbox](https://docs.zernio.com/webhooks/inbox), [envío e idempotencia](https://docs.zernio.com/messages/send-inbox-message), [inbox de WhatsApp](https://docs.zernio.com/platforms/whatsapp/inbox). Consultadas el 8 de octubre de 2026; también contrastadas con el OpenAPI oficial.

### Solicitudes del catálogo web

El agente reconoce el mensaje completo generado por el checkout (referencia `WEB-…`) y ofrece `recibir_pedido_catalogo`, sin permitir reconstruir ese carrito con herramientas de borrador. Recupera productos, opciones, cupón y datos desde la solicitud almacenada; verifica hash del mensaje, negocio, conversación, vencimiento y precios. También funciona cuando llega una frase adicional en la misma ráfaga. Prepara un resumen y botones; al aceptar, reutiliza `receiveCatalog` y crea un único pedido de origen web, asociado a la conversación. Un mensaje editado o una cotización desactualizada exige volver al carrito. No se pierde el descuento ni se crea un pedido alternativo a partir de texto interpretado por el modelo.

### Resultado de la verificación local

- Backend: 394 pruebas aprobadas en 23 archivos; lint, typecheck y build sin errores.
- Frontend: build y lint sin errores; persisten dos advertencias previas de Fast Refresh y la advertencia de tamaño de bundle.
- Navegador contra BD aislada: login, carga de configuración, activación bloqueada mientras faltan credenciales, guardado y persistencia de cuota, registro de revisión de un envío ficticio y apertura de su conversación. Sin errores de consola en la carga verificada.
- No se hicieron llamadas reales al modelo, envíos a clientes ni despliegue. Las variables locales de Zernio/R2 están presentes; su validez no fue comprobada. Faltan proveedor/modelo de IA y secreto de la suscripción para la validación real.

### OpenAI directo: verificación del 10 de octubre de 2026

Con `gpt-5.4-mini`, la ruta real del preview devolvió HTTP 200 al consultar el catálogo ficticio (gaseosa a ARS 2500) y conservó contexto para calcular dos unidades (ARS 5000). El agente nativo consultó `ver_producto` y calculó una Doble cheddar con panceta a ARS 11500 usando los recargos de la base aislada. No se crearon pedidos ni mensajes salientes. Una frase sintética en WAV se transcribió correctamente mediante `gpt-transcribe`.

Las pruebas automáticas eliminan las credenciales de IA heredadas del `.env` y desactivan el worker; solo las verificaciones manuales anteriores usaron OpenAI real. Se verificaron selección de proveedor, configuración parcial, ausencia de fallback, schemas opcionales, transcripción, cancelación y recorrido del audio verificado desde el worker. Un timeout transitorio en la primera corrida se verificó aisladamente; la segunda suite completa aprobó las 394 pruebas.

Referencias de implementación: [proveedor OpenAI de AI SDK](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [transcripción de archivos](https://developers.openai.com/api/docs/guides/speech-to-text).

### Alcance, formato y revisión del 27 de octubre de 2026

El prompt compartido por preview y agente nativo limita la conversación a la atención del negocio, incluyendo asesoramiento sobre sus productos. Permite saludos; redirige consultas ajenas sin responderlas primero y resuelve solo la parte comercial de mensajes mixtos. Los cambios de rol, las preferencias del negocio, el historial y las instrucciones incrustadas en FAQs no pueden ampliar ese alcance. No se bloquean palabras aisladas: el asesoramiento técnico puede corresponder al rubro real.

Las respuestas usan párrafos cortos, listas con guiones y negritas de WhatsApp con un solo asterisco a cada lado (`*texto*`), sin negritas Markdown dobles, tablas ni HTML. El preview interpreta únicamente ese énfasis mediante nodos React `<strong>` y conserva el resto como texto. Esto no agrega streaming: la UI conserva el indicador de espera y muestra la respuesta completa. React presenta el contenido como texto, sin interpretar HTML del modelo. El estado `is_open`, la hora local y `manual_status` prevalecen sobre afirmaciones del cliente y horarios habituales; no debe inventarse el motivo de un cierre.

La protección de datos y operaciones sigue en servidor: sesión y rol de administrador para preview, negocio fijado por sesión y RLS, herramientas de consulta cerradas, validación de entradas, memoria firmada ligada a usuario/negocio, límites de turnos/tiempo/consultas y errores del proveedor saneados. El prompt restringe comportamiento, pero no constituye una garantía contra todas las inyecciones. No introducir secretos en prompts o resultados de herramientas. Esta revisión no sustituye una auditoría de toda la plataforma ni valida envíos reales de WhatsApp.

Verificación local con proveedor real: seis mensajes consecutivos por la API del preview devolvieron HTTP 200. Consultó precios, redirigió «sabés qué es console.log», rechazó revelar prompt/clave, respondió solo el precio en una consulta mezclada con código, explicó el cierre manual y rechazó confirmar o marcar pagado un pedido en preview. Tres casos sintéticos adicionales comprobaron una FAQ con una orden maliciosa, una preferencia comercial que intentaba convertirlo en profesor de programación y asesoramiento legítimo de un vivero. No se modificaron las FAQs/configuraciones del negocio ni se crearon pedidos para estas evaluaciones. Repetir estos casos al cambiar modelo o instrucciones: el comportamiento del modelo es probabilístico.

Backend: build, typecheck y lint aprobados; 476 tests en 31 archivos aprobados, incluyendo aislamiento, permisos, memoria y herramientas. Las evaluaciones con proveedor real son manuales y separadas de esa suite.

Referencias consultadas: [Prompt engineering de OpenAI](https://developers.openai.com/api/docs/guides/prompt-engineering) y [Safety best practices](https://developers.openai.com/api/docs/guides/safety-best-practices): instrucciones explícitas, ejemplos y pruebas adversariales complementan los controles del servidor.

Formato contrastado con el [centro de ayuda de WhatsApp](https://faq.whatsapp.com/539178204879377/). El renderer del preview tiene pruebas de negritas, marcadores incompletos, listas, cálculos y escape de HTML.

### Respuestas breves y acceso al menú

El prompt compartido usa voseo argentino y respuestas de una o dos frases por defecto, sin cierres automáticos con «si querés», ofertas ni recomendaciones no solicitadas. Puede extenderse para resolver una consulta detallada, pedir datos necesarios o presentar el resumen de una operación. El tono formal conserva el voseo respetuoso; no exige frases prefabricadas ni jerga.

Ante consultas generales por menú, carta, catálogo o qué hay para pedir, envía `business.menu_url` con una introducción breve, sin listar todos los productos. El servidor construye ese enlace desde `FRONT_URL` y el slug actual del negocio tanto en preview como en el contexto nativo. No se acepta un enlace proporcionado por el cliente o una FAQ como sustituto del enlace de Toki. Consultas específicas se responden con los datos pertinentes; si el cliente pide opciones por chat o no puede abrir el enlace, se consulta el catálogo. Sin enlace disponible, se responde desde el catálogo sin inventar una URL.

Al evaluar cambios, comprobar: solicitud general del menú (link correcto), precio concreto (respuesta directa), agradecimiento (sin oferta), consulta ajena (límite breve) y solicitud explícita de opciones por chat (catálogo). La suite verifica que el preview recibe el enlace del negocio y que un cambio de slug se refleja en el turno siguiente.

### Revisión del 28/10/2026

Se comprobó en el chat de prueba una respuesta real al menú con su URL actual y una respuesta breve a `console.log`: «Por acá atiendo consultas del local.». Los enlaces del preview usan HTTP(S), abren otra pestaña con `noopener noreferrer` y el texto se renderiza sin HTML. La suite de preview cubre credenciales rechazadas sin exponer secretos y conserva aislamiento y herramientas de solo lectura. Esta comprobación de comportamiento no implica inmunidad ante todas las variantes de prompt injection; los permisos siguen impuestos por el servidor.
