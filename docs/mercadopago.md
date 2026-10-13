# Mercado Pago en toki-api

Actualizado el 12 de octubre de 2026. Backend vigente: `toki-api`.

## Estado implementado

OAuth de vendedores, interfaz de conexión y retorno, validación de cajas existentes y cobro con **QR impreso integrado sobre un pedido existente sin pagar**. Incluye creación idempotente, cancelación remota, webhook firmado, consulta autoritativa de Orders, procesador recuperable y actualización del pedido por SSE. El negocio elige aceptación manual o automática; el pago se verifica en ambos modos.

Deshabilitado por defecto. El checkout público conserva `mercadopagoEnabled: false`. Todavía no se integran Point, transferencias directas a alias/CVU, cobros externos a Toki ni nuevas ventas presenciales pendientes: el POS actual cierra ventas pagadas y no debe reutilizarse para simular un QR pendiente. La vinculación de cuentas no implementa facturación fiscal.

Implementación verificada localmente con proveedor simulado. **No se habilitó producción ni se realizó un cobro real.** Antes del piloto faltan la validación oficial con cuentas y QR de prueba de MP, aprovisionamiento asistido de caja, renovación programada, desconexión y gestión de incidencias/contracargos. [Plan del producto](../../toki/docs/MERCADO-PAGO-IMPLEMENTATION-PLAN.md).

## Configuración y activación de pruebas

1. Aplicar `0017_mercadopago_foundation` y `0018_mercadopago_qr` con el procedimiento habitual y ejecutar `npm run db:generate`.
2. Crear la aplicación de MP, configurar OAuth con PKCE S256 y registrar el retorno exacto `https://<frontend>/dashboard/settings/payments/mercadopago/callback`.
3. Completar las variables del servidor. No poner secretos en `VITE_*`.
4. Para probar, usar una base y negocio exclusivos de pruebas, `MP_ENVIRONMENT=test` y cuentas de prueba autorizadas. Los pedidos no tienen un indicador sandbox: no mezclar pruebas con pedidos reales.
5. Configurar en MP el tópico **Order (Mercado Pago)** y URL HTTPS `https://<api>/v1/webhooks/mercadopago`. Copiar su secreto al servidor.
6. Habilitar conexión y QR, abrir **Pagos**, conectar la cuenta y finalizar el retorno en la misma pestaña/sesión/negocio. Si la sesión venció, iniciar nuevamente desde Pagos; el código no se guarda en almacenamiento persistente.
7. Vincular el número de una caja existente configurada con `config.qr.operating_mode=pdv` y `external_id` alfanumérico. Se valida vía `GET /v2/pos/{pos_id}` el ID, vendedor, estado activo y modo integrado. Toki no cambia el modo ni crea sucursales automáticamente.
8. Usar una caja dedicada a Toki y **el QR impreso de esa caja**, abrir un pedido existente sin pagar y elegir «Cobrar con QR». Esperar «Esperando el pago» antes de escanear. Un QR independiente o de Point no es intercambiable con esa caja. No iniciar cobros en otra integración sobre la misma caja mientras Toki tenga un intento activo.

| Variable | Uso |
| --- | --- |
| `MP_INTEGRATION_ENABLED` | `false` por defecto. Activa OAuth y la integración. |
| `MP_QR_ENABLED` | `false` por defecto. Permite vincular cajas y crear nuevos cobros QR. |
| `MP_WEBHOOK_SECRET` | Secreto generado por MP para verificar firmas. Mínimo 16 caracteres. |
| `MP_ENVIRONMENT` | `test` o `production`; datos y credenciales separados por ambiente. |
| `MP_CLIENT_ID` / `MP_CLIENT_SECRET` | Aplicación de MP; solo servidor. |
| `MP_REDIRECT_URI` | URI fija del retorno de frontend, sin query/fragmento. HTTPS; HTTP local solo en desarrollo. |
| `MP_TOKEN_ENCRYPTION_KEY` | 32 bytes aleatorios en hexadecimal, separados de JWT. |

Generar la clave de cifrado con `openssl rand -hex 32` en el entorno de despliegue. Custodiarla junto a backups: cambiarla exige recifrar o reconectar. El logger de API elimina query strings; configurar también redacción de `code`/`state` en el proxy del frontend. Usar un Referrer-Policy restrictivo en el hosting del frontend. El callback elimina parámetros de la barra antes de solicitar completar la conexión.

## Contrato HTTP

Base autenticada `/v1/integrations/mercadopago`, JWT, negocio actual y `Cache-Control: no-store`. Importes siempre calculados desde el pedido; entradas estrictas, no se recibe monto del navegador.

| Método y ruta relativa | Permiso | Contrato |
| --- | --- | --- |
| `GET /` | Miembro | `available`, `collectionEnabled`, `environment`, `status`, `sellerId`, `acceptanceMode`, vencimientos y cajas. |
| `POST /connect` | Owner/admin | `authorizationUrl`, `expiresAt`; state de un uso ligado a usuario y negocio. |
| `POST /complete` | Administrador iniciador | `{state, code}`; intercambio con PKCE, guarda credenciales cifradas. |
| `POST /refresh` | Owner/admin | Renovación explícita con exclusión de intercambios concurrentes. |
| `PATCH /` | Owner/admin | `{acceptanceMode: "manual" | "automatic"}`; solo afecta próximos intentos. |
| `POST /registers` | Owner/admin | `{posId: "111"}`; valida una caja ya preparada en MP y devuelve registro. |
| `GET /orders/:orderId/attempts` | Miembro | Intentos del pedido y ambiente, más reciente primero, sin secretos. |
| `POST /attempts` | Miembro | `{orderId, registerId, requestId}` (UUIDs). Responde **202** con intento persistido; aún no implica orden creada en MP. Reutilizar requestId ante respuesta incierta. |
| `POST /attempts/:id/check` | Miembro | **202**, programa consulta durable; no significa pago verificado. |
| `POST /attempts/:id/cancel` | Miembro | **202**, solicita cancelar; solo libera al comprobar resultado remoto. |
| `POST /v1/webhooks/mercadopago` | Firma MP, sin JWT | Query `data.id`; headers `x-signature`, `x-request-id`; sobre de tópico `order`. **200** después de persistir recepción y programar consulta. |

DTO de intento: `id`, `orderId`, `registerId`, `amount` numérico, `status`, `reviewReason`, `providerOrderId`, `acceptanceMode`, `cancelRequested`, `lastCheckedAt`, `confirmedAt`, `createdAt`.

Estados: `created` (reservado/preparando), `pending`, `unknown`, `paid`, `failed`, `canceled`, `expired`, `refunded`. `reviewReason` no nulo requiere revisión; no implica acreditación. `failed` queda reservado para rechazos definitivos; un HTTP 4xx, un timeout o un estado desconocido no liberan por sí solos una reserva.

## Flujo y consistencia

- La transacción bloquea el pedido, verifica membresía, monto positivo y ausencia de pago previo, congela importe/moneda/caja/preferencia y guarda el cuerpo exacto y la clave idempotente. El pedido pasa a medio Mercado Pago pendiente.
- Índices parciales permiten un único intento activo por pedido y caja. `unknown` sigue reservado. Un segundo clic devuelve el intento existente; una caja ocupada por otro pedido rechaza el cobro.
- El worker arranca con `server.ts`, revisa la cola cada 2 segundos en lotes acotados y usa `SKIP LOCKED`, lease de 60 segundos y token de posesión. Una instancia caída libera el trabajo al vencer el lease. Respuestas de un worker anterior no pueden aplicar cambios.
- Crea `POST /v1/orders` con tipo QR, modo static, vencimiento de 15 minutos, `external_pos_id` validado y `X-Idempotency-Key`. Guarda el ID remoto y consulta `GET /v1/orders/{id}`, incluso después de un POST exitoso.
- Verifica vendedor, aplicación, referencia, ID de orden/pago, moneda ARS, país, caja, importe de orden/transacción y estados. Solo `processed` + transacción `processed/accredited` sin incidencias habilita aceptación automática.
- El webhook valida HMAC SHA-256 con ID en minúsculas y comparación en tiempo constante. No se confía en estados/importes del body. Se comprueba aplicación, ambiente y coincidencia del ID del body con la query. El timestamp está firmado pero no se descartan avisos por antigüedad, para admitir reentregas de MP; la deduplicación y la consulta autoritativa evitan efectos repetidos.
- Evento reducido y programación de consulta se guardan en la misma transacción. `mp_webhook_events.status=processed` significa **aviso recibido y consulta programada**, no pago aprobado. Un evento para un recurso no iniciado en Toki no crea ni asocia un pago. Si llegó antes del ID remoto, despierta intentos sin ID del vendedor para recuperar la respuesta del mismo POST.
- Pago, resumen del pedido, historial y aceptación se aplican atómicamente. `payments.mp_attempt_id` es único y su FK compuesta valida negocio/pedido. El ID del pago es independiente del requestId recibido. La transición automática de sistema escribe historial sin suplantar a un usuario; aceptación manual sigue usando `update_order_status`.
- Triggers impiden marcar manualmente un pago MP, cambiar importe/medio con intento activo o cancelar el pedido antes de resolver el cobro. Un pago MP confirmado tampoco admite alterar el importe. Se preservan las operaciones existentes de stock/cancelación; verificar el pago no vuelve a descontar stock.
- Cambios en orders disparan el SSE existente. El detalle consulta intentos cada 5 segundos como recuperación y vuelve a leer el pedido si cambió el intento. No hay garantía contractual de latencia: depende de MP, red, cola y SSE.

## Cancelaciones, devoluciones y fallos

Cancelar solicita `/v1/orders/{id}/cancel` solo si el proveedor sigue en `created`, con otra clave idempotente estable. Siempre se reconsulta. Solo `canceled` o `expired` verificados liberan la caja y restauran el medio original (efectivo/transferencia). Solicitar cancelar no cancela el pedido ni devuelve dinero.

Un pago tardío se registra y señala para revisión; nunca reactiva un pedido cancelado. Si estaba cancelado, se genera una devolución pendiente. La devolución total verificada actualiza el pago a `refunded` y completa la devolución pendiente de cancelación que coincide en importe. Una devolución parcial muestra `partial_refund` y bloquea aceptación automática: el cálculo/conciliación de saldo parcial queda pendiente. Contracargos y reclamos todavía no tienen circuito propio.

Con error del proveedor, reintenta con espera progresiva de 15 segundos a 5 minutos. Los pendientes se reconsultan cada 30 segundos; pagos verificados, cada hora hasta 80 días. Los webhooks y «Verificar ahora» pueden adelantar una consulta. MP limita el GET de Orders a órdenes de menos de 3 meses.

Si no se recuperó el ID de una creación en una hora, se detiene su replay con `creation_unresolved`; la reserva queda retenida. El operador debe investigar en MP antes de cualquier intervención. No hay botón para forzar liberación ni asociar otro cobro por importe. Los intentos ya ligados a un ID siguen usando GET.

Si vence/revoca la conexión, reconectar o renovar desde Pagos; no se asume que el pago falló. El refresh usa un lease por conexión, valida vendedor/ambiente/permisos y ante respuesta incierta solicita reconexión. **La renovación programada y alertas operativas quedan pendientes antes de un piloto sin supervisión.**

Para suspender nuevos cobros usar `MP_QR_ENABLED=false` y conservar `MP_INTEGRATION_ENABLED=true`, secreto, tokens y worker. Webhooks, consultas y cancelaciones de intentos anteriores siguen activos. No apagar toda la integración mientras existan cobros sin resolver. Esta entrega usa flag global; el control fino de habilitación por negocio queda pendiente.

## Seguridad y base de datos

Todas las queries usan `withDb`; las transacciones fijan UTC porque adapter-pg 6 serializa DateTime sin offset. El servicio verifica permisos antes de acceder con service_role. Conexiones/cajas/intentos solo se leen con membresía RLS; secretos, flujos OAuth y eventos no tienen grants de navegador. Credenciales MP cifradas con AES-256-GCM y contexto negocio/ambiente/finalidad; tokens de sesión Toki permanecen hasheados. No se exponen cuerpos de error ni tokens del proveedor.

Las FKs, índices parciales y triggers se mantienen en SQL; revisar migraciones autogeneradas antes de usarlas. No reutilizar ni editar una migración ya desplegada.

## Verificación

Usar PostgreSQL de pruebas aislado: `test:prepare` recrea la base `DATABASE_URL_TEST` y cambia el rol de aplicación del clúster. No ejecutarlo en un clúster productivo. Sin engine disponible se puede usar `MIGRATE_WITH=sql`; no mezclar ese modo con Prisma Migrate en la misma base.

Backend: `npm run db:generate`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`. Frontend: `npm run build`, `npm run lint`.

La suite cubre OAuth/PKCE/cifrado, RLS, firma y ambiente, unicidad, membresía, dobles clics, importes/cuentas/referencias incorrectos, timeout, recuperación de lease, cancelación, preferencia capturada, regresión de estados, devoluciones y continuidad al suspender nuevos cobros. Los tests sustituyen fetch; nunca utilizan credenciales reales de MP.

Prueba de navegador local: cuenta y caja simuladas → preferencia automática → pedido TK-300001 → cobro de ARS 1.234,56 → webhook firmado simulado → pago verificado y pedido confirmado sin recargar. La base mostró un solo pago ligado al intento con `verification=mercadopago_orders_api`. La prueba no valida OAuth real, escaneo ni acreditación real.

Resultado local de la etapa QR: **433 pruebas aprobadas en 25 archivos** (36 de Mercado Pago), migraciones 0001–0018 verificadas en PostgreSQL temporal, lint/typecheck/build del backend correctos y build/lint del frontend correctos. Persisten las dos advertencias anteriores de React Refresh y la advertencia de bundle grande. No se modificó la base operativa ni se usaron credenciales reales.

La entrega del POS del 13/10/2026 amplía el total a **436 pruebas en 26 archivos**, con tres pruebas de catálogo paginado. El POS admite efectivo y transferencia confirmada manualmente; el cobro MP pendiente desde POS sigue fuera de esta entrega.

## Referencias oficiales revisadas

- [OAuth y PKCE](https://www.mercadopago.com.ar/developers/es/docs/qr-code/additional-content/security/oauth/creation).
- [Obtener caja](https://www.mercadopago.com.ar/developers/es/reference/in-person-payments/qr-code/pos/get-pos/get).
- [Crear, consultar y cancelar una order QR](https://www.mercadopago.com.ar/developers/es/docs/qr-code/payment-processing).
- [Webhooks QR](https://www.mercadopago.com.ar/developers/es/docs/qr-code/notifications) y [manifest HMAC de Orders](https://www.mercadopago.com.ar/developers/es/docs/wallet-connect/notifications).
- [Estados de order y transacción](https://www.mercadopago.com.ar/developers/es/docs/qr-code/resources/status-order-transaction).
