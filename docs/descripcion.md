# Toki API — Descripción del proyecto

**Producto:** Toki · **Repo:** `toki-platform/toki-api` · **Fecha:** 2026-09-17 · **Versión del doc:** 1.0

**Docs relacionados:**

- [`setup-local.md`](setup-local.md): cómo levantar el proyecto en tu compu
- [`stack.md`](stack.md): tecnologías y versiones
- [`arquitectura.md`](arquitectura.md): despliegue, seguridad, estructura del código
- [`api.md`](api.md): contrato completo de endpoints
- [`base-de-datos.md`](base-de-datos.md): modelo de datos, RLS, funciones y migración desde Supabase
- [`plan-implementacion.md`](plan-implementacion.md): fases y orden de trabajo

---

## 1. Qué es Toki

SaaS multi-tenant para **negocios gastronómicos de delivery y take away**. Cada negocio:

- carga su **menú digital** (categorías, productos, variantes y extras, stock),
- comparte un **link público** donde sus clientes arman el pedido y hacen checkout,
- administra los pedidos desde un **dashboard** (kanban en tiempo real, venta presencial, pagos, clientes),
- conecta su **WhatsApp**, donde un **agente de IA** responde consultas, toma pedidos y recibe comprobantes de pago.

Fuera de alcance en V1: salón, mesas, mozos, reservas, división de cuentas, cobro de suscripciones.

## 2. Qué es este repo

`toki-api` es el **backend propio de Toki**. Reemplaza a Supabase como backend:

| Hoy (Supabase) | Con toki-api |
| --- | --- |
| Supabase Auth | Módulo `auth` propio (JWT + refresh rotativo, bcrypt, emails con Resend) |
| PostgREST (`supabase.from(...)`) desde el navegador | Endpoints REST en Express |
| RPC de Postgres llamadas desde el navegador | Las mismas funciones SQL, llamadas desde services |
| Edge Functions (`create-order`, `zernio-whatsapp-*`) | Módulos `public`, `orders`, `whatsapp` |
| Supabase Storage | Cloudflare R2 con URLs prefirmadas |
| Supabase Realtime | LISTEN/NOTIFY de Postgres + SSE |
| Postgres gestionado | PostgreSQL 17 en VPS con Dokploy, backups a R2 |
| n8n llamando a PostgREST con service key | n8n llamando a `/v1/agent/*` con API key |

La base de datos **replica exactamente el schema productivo de Supabase** (28 tablas, 60 policies RLS, 28 funciones), para migrar los datos sin transformaciones. Ver `base-de-datos.md`.

## 3. Componentes del sistema

| Componente | Repo | Rol | Cambia con este proyecto |
| --- | --- | --- | --- |
| **toki-api** | `toki-platform/toki-api` | Backend REST | Nuevo |
| **PostgreSQL 17** | (Dokploy) | Base de datos | Nuevo, réplica de Supabase |
| **Front** | `toki-platform/toki` | SPA Vite + React en Vercel | Solo la **capa de datos**: `supabase-js` pasa a un cliente HTTP. Las pantallas no cambian |
| **Agente WhatsApp** | `toki-platform/toki-agents` | Workflow n8n `toki-agent-v2` | Cambian las URLs de los nodos HTTP y el header de auth |
| **Zernio** | externo | Proveedor de WhatsApp | Sin cambios (el webhook sigue entrando a n8n) |
| **Cloudflare R2** | externo | Archivos y backups | Nuevo |
| **Resend** | externo | Emails transaccionales | Nuevo |

## 4. Módulos del backend

Detalle de rutas, permisos y servicios en `api.md`.

| # | Módulo | Responsabilidad | Quién lo usa |
| --- | --- | --- | --- |
| 1 | `health` | Estado de la API y de la base | Dokploy, monitoreo |
| 2 | `auth` | Registro, verificación de email, login, refresh, logout, recuperación de contraseña | Front |
| 3 | `account` | Perfil del usuario (nombre, teléfono) | Front |
| 4 | `businesses` | Onboarding, datos del negocio, estado abierto/cerrado, horarios y horarios especiales, checklist | Front |
| 5 | `settings` | Medios de pago, fidelización, configuración del bot y FAQs | Front |
| 6 | `coupons` | CRUD de cupones | Front |
| 7 | `catalog` | Categorías, productos con opciones y valores, disponibilidad, stock, ingredientes | Front |
| 8 | `uploads` | URLs prefirmadas de R2 para imágenes | Front |
| 9 | `orders` | Tablero de pedidos, detalle, cambio de estado, marcar pagado, venta presencial, comprobantes, tiempo real | Front |
| 10 | `customers` | Historial de clientes | Front |
| 11 | `dashboard` | Métricas y búsqueda global | Front |
| 12 | `whatsapp` | Conexión con Zernio, inbox de conversaciones, tomar y devolver conversaciones | Front |
| 13 | `public` | Menú por slug, detalle de producto, validación de cupón, checkout, seguimiento del pedido | Clientes finales |
| 14 | `agent` | Tools del agente de IA: contexto, catálogo, borrador de pedido, confirmación, handoff, comprobantes | n8n |

**Librerías transversales:** acceso a datos con contexto RLS, tokens, contraseñas, mailer (Resend), R2, Zernio, cálculo de pedidos, hub de tiempo real, errores.

## 5. Flujos principales

1. **Alta de negocio:** registro → email de verificación (Resend) → login → onboarding (`create_business_with_owner` crea negocio, owner, bot y horarios).
2. **Carga del menú:** categorías → productos con opciones → imágenes a R2 por URL prefirmada.
3. **Pedido web:** el cliente abre `/:slug` → arma el carrito → `POST /v1/public/businesses/:slug/orders` valida horario, stock, opciones, cupón, mínimo y medio de pago, recalcula precios y persiste con `persist_order`. `NOTIFY` avisa al dashboard por SSE.
4. **Gestión:** el negocio mueve el pedido en el kanban (`update_order_status` guarda historial) y marca el pago (`mark_order_paid`). El cliente sigue el pedido en `/:slug/order/:code`.
5. **Venta presencial:** POS → `create_manual_sale` (descuenta stock, valida pago y descuento).
6. **Pedido por WhatsApp:** Zernio → n8n → el agente usa `/v1/agent/*` para buscar productos y armar el borrador. Al confirmar, pasa por el **mismo cálculo** que el checkout web.
7. **Comprobante de transferencia:** n8n envía el adjunto a `/v1/agent/payment-proofs` → R2 privado → el negocio lo aprueba o rechaza desde el detalle del pedido.

## 6. Reglas de negocio que el backend garantiza

- **`business_id` es la frontera multi-tenant.** RLS de Postgres es la autorización real; los checks en Express son fail-fast.
- **Los precios nunca vienen del cliente.** Ni el front ni el agente mandan totales: mandan productos, cantidades y opciones.
- **Crear un pedido tiene un solo camino** (`orderPricing` + `persist_order`), compartido por la web y WhatsApp.
- **Cambiar un estado escribe historial** (`update_order_status`).
- **Un comprobante es evidencia, no pago.** Solo el negocio lo aprueba, y marcar pagado es una acción separada.
- **Idempotencia del canal:** los mensajes de WhatsApp se deduplican por `provider_message_id`, y confirmar un borrador ya confirmado devuelve el pedido existente.
- **Los secretos nunca llegan al navegador:** API keys de Zernio, R2, Resend y el secreto JWT viven solo en el backend.

## 7. Glosario

| Término | Significado |
| --- | --- |
| Negocio (business) | Tenant. Todo dato operativo tiene `business_id` |
| Miembro | Usuario con rol `owner`, `admin` o `staff` en un negocio (`business_members`) |
| Borrador (draft) | Pedido en armado dentro de una conversación de WhatsApp |
| Handoff | Conversación derivada a una persona del negocio: el bot deja de responder |
| Comprobante | Imagen o documento de pago recibido por WhatsApp |
| Contexto de BD | Rol con el que corre cada transacción: `anon`, `authenticated` o `service_role` |
