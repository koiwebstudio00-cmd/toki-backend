# Toki API — Base de datos

**Motor:** PostgreSQL 17 · **Fecha:** 2026-09-17 · **Versión:** 1.0

**Fuente:** réplica exacta del schema productivo de Supabase (`toki/supabase/migrations`, 27 archivos, ~3.800 líneas SQL).

**Artefactos en el repo:**

| Archivo | Contenido |
| --- | --- |
| `prisma/migrations/0001_baseline_supabase/migration.sql` | Schema completo consolidado: tablas, enums, constraints, índices, 60 policies, 28 funciones, triggers, grants |
| `prisma/migrations/0002_auth_sessions/migration.sql` | Sesiones y tokens de la auth propia |
| `prisma/migrations/0003_realtime_notify/migration.sql` | Trigger de NOTIFY para tiempo real |
| `prisma/migrations/0004_public_is_open/migration.sql` | Permisos que Supabase daba de fábrica: `business_is_open` para `anon` y USAGE sobre el esquema `extensions` (F3) |
| `prisma/migrations/0005_stock_respeta_track_stock/migration.sql` | `persist_order` y `create_manual_sale` validan y descuentan stock solo si `track_stock` está activo (F3, hallazgo H5) |
| `prisma/migrations/0006_payment_proof_idempotencia/migration.sql` | `order_payment_proofs.provider_message_id` + índice único parcial: el webhook se reintenta (F4) |
| `prisma/migrations/0007_agent_stock_track_stock/migration.sql` | Las funciones `agent_*` también respetan `track_stock` (F4, hallazgo H5) |
| `prisma/migrations/0008_agente_v3_contexto/migration.sql` | Agente v3, fase V1: búsqueda por palabras sin acentos (`agent_search_terms`, `agent_search_text`, `agent_search_products`, `agent_search_faq`), trigger que actualiza `whatsapp_order_drafts.updated_at` al cambiar un item (vencimiento del borrador a las 4 h) y `bot_settings.bot_name` por defecto `Sofi` |
| `prisma/migrations/0009_agente_v3_borrador/migration.sql` | Agente v3, fase V2: `agent_draft_set_details` borra la dirección al pasar a retiro |
| `prisma/schema.prisma` | Modelos Prisma (31) generados desde la réplica, validados con el engine de Prisma 6.19 |
| `scripts/bootstrap-prod.sql` | Creación del rol de la API en producción |

## 1. Cómo se construyó y verificó la réplica

1. **Base limpia:** PostgreSQL sin Supabase, con una capa de compatibilidad (roles `anon`/`authenticated`/`service_role`, `auth.uid()`, schema `auth`, privilegios por defecto de Supabase).
2. **Migraciones:** se aplicaron las 27 en orden. Una no aplica sobre un historial limpio (ver hallazgo H1) y se excluyó porque su efecto ya está en la anterior.
3. **Limpieza:** se quitó lo exclusivo de Supabase (schema `storage` y sus 5 policies, publicación `supabase_realtime`) y se exportó el schema consolidado como `0001`.
4. **Verificación en una base nueva** con `0001` a `0007`:
   - **Conteo idéntico:** 28 tablas en `public` + `auth.users`, 60 policies, 22 triggers y 71 índices, igual que la réplica.
   - **Aislamiento:** con dos usuarios y dos negocios creados por `create_business_with_owner`, el usuario A no ve `bot_settings` de B y su `UPDATE` sobre categorías de B afecta 0 filas.
   - **Contexto `anon`:** ve negocios activos y 0 pedidos.
   - **Rol de conexión:** sin `SET ROLE`, `toki_app` recibe *permission denied*.
   - **Pedidos:** `persist_order` (como `service_role`) crea el pedido y descuenta stock (10 → 8); `update_order_status` (como owner) escribe historial; `get_public_order` (como `anon`) devuelve el estado.
   - **Realtime:** el trigger de `orders` emite `NOTIFY toki_orders` con `business_id`, `order_id` y `op`.

## 2. Schemas

| Schema | Contenido |
| --- | --- |
| `public` | Todas las tablas de negocio, enums y funciones de dominio |
| `private` | Helpers de RLS (`is_business_member`, `has_business_role`) y `notify_order_change` |
| `auth` | `users`, `refresh_tokens`, `email_tokens`, función `uid()`. Solo accesible con `service_role` |
| `extensions` | `citext`, `pg_trgm`, `unaccent` |

## 3. Enums

| Enum | Valores |
| --- | --- |
| `business_role` | `owner`, `admin`, `staff` |
| `order_status` | `pending`, `confirmed`, `preparing`, `ready`, `out_for_delivery`, `delivered`, `cancelled` |
| `order_type` | `delivery`, `takeaway` |
| `payment_method` | `cash`, `transfer`, `mercadopago` |
| `payment_status` | `pending`, `paid`, `failed`, `refunded` |

**Estados como `text` con CHECK:**

| Columna | Valores |
| --- | --- |
| `businesses.manual_status` | `auto`, `open`, `closed` |
| `orders.source` | `web`, `whatsapp`, `manual` |
| `coupons.discount_type` | `percent`, `fixed` |
| `product_options.type` | `single`, `multiple` |
| `inventory_ingredients.unit` | `kg`, `g`, `l`, `ml`, `unit` |
| `payments.provider` | `cash`, `transfer`, `mercadopago`, `manual` |
| `order_payment_proofs.status` | `pending`, `approved`, `rejected` |
| `whatsapp_conversations.status` | `open`, `closed`, `handoff` |
| `whatsapp_messages.direction` | `inbound`, `outbound` |
| `whatsapp_messages.message_type` | `text`, `image`, `audio`, `document`, `unknown` |
| `whatsapp_integrations.provider` | `meta`, `zernio` |
| `whatsapp_order_drafts.status` | `open`, `confirmed`, `cancelled` |
| `auth.email_tokens.purpose` | `verify_email`, `reset_password` |

## 4. Tablas

Todas las tablas de `public` tienen `id uuid` (default `gen_random_uuid()`), `business_id` con FK a `businesses` (`on delete cascade`), `created_at`, y `updated_at` mantenido por el trigger `set_updated_at`, salvo donde se indica. El detalle columna por columna está en `0001_baseline_supabase` y `schema.prisma`.

### 4.1 Identidad y negocios

| Tabla | Propósito | Columnas clave | Restricciones |
| --- | --- | --- | --- |
| `auth.users` | Cuenta de acceso (reemplaza Supabase Auth) | `email citext`, `password_hash`, `email_verified_at`, `raw_user_meta_data`, `last_login_at` | `email` único. Trigger `on_auth_user_created` → crea `profiles` |
| `auth.refresh_tokens` | Sesiones | `user_id`, `token_hash`, `expires_at`, `revoked_at`, `replaced_by`, `user_agent` | `token_hash` único |
| `auth.email_tokens` | Verificación de email y reset | `user_id`, `purpose`, `token_hash`, `expires_at`, `used_at` | `token_hash` único |
| `profiles` | Datos visibles del usuario | `id` (= `auth.users.id`), `full_name`, `phone`, `avatar_url` | `phone` ≤ 40. Sin `business_id` |
| `businesses` | Tenant | `name`, `slug`, `description`, `business_type`, `logo_url`, `cover_url`, `phone`, `whatsapp_phone`, `address`, `city`, `country`, `currency`, `timezone`, `estimated_delivery_minutes`, `minimum_order_amount`, `delivery_fee`, `is_active`, `manual_status` | `slug` único con formato kebab; montos ≥ 0 |
| `business_members` | Usuario ↔ negocio + rol | `user_id` → `auth.users`, `role business_role` | Único `(business_id, user_id)` |
| `business_hours` | Horario semanal, hasta 2 franjas | `day_of_week 0-6`, `is_open`, `opens_at`, `closes_at`, `opens_at_2`, `closes_at_2` | Único `(business_id, day_of_week)`; franja 2 completa o vacía |
| `business_special_hours` | Feriados y excepciones | `date`, `is_closed`, `opens_at`, `closes_at`, `note` | Único `(business_id, date)` |

### 4.2 Catálogo

| Tabla | Propósito | Columnas clave | Restricciones |
| --- | --- | --- | --- |
| `categories` | Categorías del menú | `name`, `description`, `image_url`, `sort_order`, `is_active` | — |
| `products` | Productos | `category_id` (→ categories, `set null`), `name`, `description`, `price`, `image_url`, `is_available`, `is_featured`, `preparation_minutes`, `sort_order`, `barcode`, `track_stock`, `stock_quantity`, `low_stock_threshold` | `barcode` único por negocio (default `TKI-` + 10 hex), precio ≥ 0 |
| `product_options` | Grupos de variantes y extras | `product_id`, `name`, `type`, `is_required`, `min_select`, `max_select`, `sort_order` | `max_select ≥ 1` y `≥ min_select` |
| `product_option_values` | Valores de cada grupo | `option_id`, `name`, `price_delta`, `is_available`, `sort_order`, `track_stock`, `stock_quantity`, `low_stock_threshold` | stock ≥ 0 |
| `inventory_ingredients` | Stock de insumos | `name`, `quantity numeric(12,3)`, `unit`, `low_stock_threshold`, `notes` | Único `(business_id, name)` |

### 4.3 Clientes, pedidos y pagos

| Tabla | Propósito | Columnas clave | Restricciones |
| --- | --- | --- | --- |
| `customers` | Cliente por negocio y teléfono | `name`, `phone`, `email`, `loyalty_points`, `total_spent` | Único `(business_id, phone)` |
| `customer_addresses` | Direcciones | `customer_id`, `label`, `street`, `details`, `city` | — |
| `orders` | Cabecera del pedido | `customer_id`, `order_code`, `status`, `order_type`, `customer_name`, `customer_phone`, `delivery_address`, `delivery_notes`, `notes`, `subtotal`, `delivery_fee`, `discount_total`, `total`, `payment_method`, `payment_status`, `source`, `coupon_id`, `coupon_code`, `loyalty_points_earned`, `loyalty_points_redeemed`, `whatsapp_conversation_id` | `order_code` único `^TK-[0-9]{6}$`; delivery exige dirección |
| `order_items` | Snapshot de cada producto | `order_id`, `product_id` (`set null`), `product_name`, `quantity`, `unit_price`, `total_price`, `notes` | Cantidad > 0 |
| `order_item_options` | Snapshot de opciones elegidas | `order_item_id`, `option_name`, `value_name`, `price_delta` | Sin `updated_at` |
| `order_status_history` | Auditoría de estados | `order_id`, `from_status`, `to_status`, `changed_by` (→ `auth.users`), `note` | Sin `updated_at` |
| `payments` | Registro del pago | `order_id`, `provider`, `status`, `amount`, `external_payment_id`, `metadata` | — |
| `order_payment_proofs` | Comprobantes por WhatsApp | `order_id`, `conversation_id`, `storage_path` (key de R2), `media_type`, `status`, `reviewed_at`, `reviewed_by` (→ profiles) | Sin `updated_at` |
| `coupons` | Cupones | `code`, `description`, `discount_type`, `discount_value`, `minimum_order_amount`, `starts_at`, `ends_at`, `usage_limit`, `used_count`, `is_active` | Único `(business_id, code)` |

### 4.4 Configuración

| Tabla | PK | Columnas |
| --- | --- | --- |
| `payment_settings` | `business_id` | `cash_enabled`, `transfer_enabled`, `transfer_cbu`, `transfer_alias`, `transfer_holder`, `transfer_bank`, `mercadopago_enabled` |
| `loyalty_settings` | `business_id` | `is_enabled`, `points_per_currency`, `points_per_order`, `redeem_rate`, `min_points_to_redeem` |
| `bot_settings` | `id` (único por negocio) | `is_enabled`, `bot_name`, `tone`, `fallback_message`, `handoff_enabled` |
| `bot_faqs` | `id` | `question`, `answer`, `is_active` |

### 4.5 WhatsApp y agente

| Tabla | Propósito | Columnas clave | Restricciones |
| --- | --- | --- | --- |
| `whatsapp_integrations` | Conexión por negocio | `provider`, `provider_external_id` (accountId de Zernio), `provider_metadata`, `phone_number`, `is_active` + columnas legacy de Meta (`phone_number_id`, `waba_id`, `access_token_encrypted`, `verify_token`) | Única por negocio; único parcial `(provider, provider_external_id)` |
| `whatsapp_conversations` | Conversación por contacto | `contact_id`, `phone`, `customer_id`, `status`, `handoff_reason`, `last_message_at` | Único `(business_id, contact_id)` |
| `whatsapp_messages` | Mensajes entrantes y salientes | `conversation_id`, `direction`, `message_type`, `content`, `raw_payload`, `ai_intent`, `provider_message_id` | Único parcial `(business_id, provider_message_id)`: dedup. Sin `updated_at` |
| `whatsapp_order_drafts` | Borrador de pedido del agente | `conversation_id` (único), `status`, `customer_name`, `order_type`, `delivery_address`, `payment_method`, `notes`, `order_id` | — |
| `whatsapp_order_draft_items` | Items del borrador | `draft_id`, `product_id`, `product_name`, `quantity 1-50`, `unit_price`, `total_price`, `option_value_ids uuid[]`, `options jsonb`, `notes` | Sin `updated_at` |

### 4.6 Relaciones

```text
auth.users ─┬─ profiles (1:1)
            ├─ business_members ── businesses
            ├─ refresh_tokens · email_tokens
            └─ order_status_history.changed_by

businesses ─┬─ business_hours · business_special_hours
            ├─ payment_settings (1:1) · loyalty_settings (1:1) · bot_settings (1:1) · bot_faqs
            ├─ categories ── products ── product_options ── product_option_values
            ├─ inventory_ingredients · coupons
            ├─ customers ── customer_addresses
            ├─ orders ─┬─ order_items ── order_item_options
            │          ├─ order_status_history · payments · order_payment_proofs
            │          └─ coupon_id → coupons · customer_id → customers
            ├─ whatsapp_integrations (1:1)
            └─ whatsapp_conversations ─┬─ whatsapp_messages
                                       ├─ whatsapp_order_drafts ── whatsapp_order_draft_items
                                       └─ orders.whatsapp_conversation_id
```

## 5. Funciones SQL

`[D]` = `SECURITY DEFINER`, con `search_path` vacío y validación propia de pertenencia.

| Función | Tipo | Quién la ejecuta | Qué hace | La usa |
| --- | --- | --- | --- | --- |
| `private.is_business_member(business_id)` | [D] | authenticated | ¿`auth.uid()` es miembro? | Policies |
| `private.has_business_role(business_id, roles[])` | [D] | authenticated | ¿Tiene alguno de los roles? | Policies |
| `public.handle_new_user()` | [D] trigger | — | Crea `profiles` al insertar en `auth.users` | Registro |
| `public.set_updated_at()` | trigger | — | `updated_at = now()` | 21 tablas |
| `public.create_business_with_owner(name, slug, phone, address, city, description)` | [D] | authenticated | Crea negocio, owner, `bot_settings` y horarios | `businesses.createWithOwner` |
| `public.update_order_status(order_id, status, note)` | [D] | authenticated | Valida membresía, cambia estado y escribe historial | `orders.changeStatus` |
| `public.mark_order_paid(order_id)` | [D] | authenticated | Marca `payment_status = paid` y el pago asociado | `orders.markPaid` |
| `public.create_manual_sale(jsonb)` | [D] | authenticated | Venta POS: valida, calcula, descuenta stock, crea pedido `source = manual` | `orders.createManualSale` |
| `public.persist_order(jsonb)` | [D] | **solo service_role** | Transacción del pedido: cliente, dirección, pedido, items, opciones, historial, pago, cupón, puntos, stock | `public.createOrder`, `agent.confirmDraft` |
| `public.get_public_order(code)` | [D] | anon, authenticated | Vista pública limitada del pedido | `public.trackOrder` |
| `public.business_schedule_windows(business_id, date)` | [D] | — | Franjas del día, considerando horarios especiales | `business_is_open` |
| `public.business_is_open(business_id)` | [D] | authenticated, service_role | Estado manual + franjas en la zona horaria del negocio (cruce de medianoche incluido) | Menú, checkout, agente |
| `public.search_dashboard(business_id, term)` | invoker (RLS) | authenticated | Búsqueda difusa (`pg_trgm` + `unaccent`) de productos, clientes y pedidos | `dashboard.search` |
| `public.agent_context(business_id, conversation_id, k)` | [D] | service_role | Negocio, horarios, pagos, últimos k mensajes, borrador y pedido editable | `agent.context` |
| `public.agent_search_products(business_id, q, limit)` | [D] | service_role | Catálogo con `requiere_opciones` y stock | `agent.searchProducts` |
| `public.agent_product_detail(business_id, product_id)` | [D] | service_role | Opciones, obligatorias y precios extra | `agent.productDetail` |
| `public.agent_search_faq(business_id, q, limit)` | [D] | service_role | FAQs activas | `agent.searchFaq` |
| `public.agent_order_status(business_id, conversation_id, code)` | [D] | service_role | Pedido por código o por contacto | `agent.orderStatus` |
| `public.agent_draft_ensure` / `agent_draft_json` / `agent_draft_get` | [D] | service_role | Crea o lee el borrador con `falta` y `listo_para_confirmar` | Internas |
| `public.agent_draft_add_item(...)` | [D] | service_role | Valida producto, opciones y stock; suma el item con precio real | `agent.draftAddItem` |
| `public.agent_draft_remove_item(...)` | [D] | service_role | — | `agent.draftRemoveItem` |
| `public.agent_draft_set_details(...)` | [D] | service_role | Nombre, entrega, dirección, pago, notas | `agent.draftSetDetails` |
| `public.agent_draft_cancel(...)` | [D] | service_role | — | `agent.draftCancel` |
| `public.agent_resolve_editable_order` / `agent_order_json` | [D] | service_role | Pedido `pending` sin pago del contacto | Internas |
| `public.agent_order_update_details(...)` | [D] | service_role | Corrige entrega, dirección o pago de un pedido pendiente | `agent.updateOrderDetails` |
| `public.agent_order_add_draft_items(...)` | [D] | service_role | Suma los items del borrador a un pedido pendiente | `agent.addDraftItemsToOrder` |
| `public.agent_conversation_handoff(business_id, conversation_id, reason)` | [D] | service_role | `status = handoff` con motivo | `agent.handoff` |
| `private.notify_order_change()` | [D] trigger | — | `pg_notify('toki_orders', ...)` | Realtime (`0003`) |

**Regla a futuro:** la lógica nueva va en TypeScript. Una función SQL se toca solo para corregirla o, si hay que reescribirla, se evalúa pasarla al service.

## 6. Autorización (RLS)

### 6.1 Contextos

La API corre cada transacción con `SET LOCAL ROLE` + `request.jwt.claims` (ver `arquitectura.md` §5).

| Contexto | Uso | RLS |
| --- | --- | --- |
| `anon` | Rutas públicas | Aplica: solo policies públicas |
| `authenticated` | Panel (con `sub` del usuario) | Aplica: membresía y rol vía `private.*` |
| `service_role` | Auth, agente, checkout, scripts | `BYPASSRLS`; la función o el service valida pertenencia |

### 6.2 Matriz de policies (`public`)

| Tabla | anon | miembro (cualquier rol) | owner/admin |
| --- | --- | --- | --- |
| `businesses` | SELECT activos | SELECT (incluso inactivo) | UPDATE |
| `business_members` | — | SELECT propios o del negocio | — |
| `business_hours` | SELECT (negocio activo) | SELECT | ALL |
| `business_special_hours` | SELECT (negocio activo) | — | ALL |
| `categories` | SELECT activas | SELECT todas | ALL |
| `products` | SELECT disponibles | SELECT todos | ALL |
| `product_options` / `product_option_values` | SELECT disponibles | SELECT todos | ALL |
| `inventory_ingredients` | — | SELECT | INSERT, UPDATE, DELETE |
| `coupons` | SELECT activos (ver H2) | — | ALL |
| `payment_settings` / `loyalty_settings` | SELECT (negocio activo) | — | ALL |
| `bot_settings` / `bot_faqs` | — | SELECT | ALL |
| `customers` / `customer_addresses` | — | ALL | — |
| `orders` / `order_items` / `order_item_options` / `order_status_history` / `payments` | — | ALL | — |
| `order_payment_proofs` | — | SELECT, UPDATE | — |
| `whatsapp_integrations` | — | — | ALL |
| `whatsapp_conversations` / `whatsapp_messages` | — | ALL | — |
| `whatsapp_order_drafts` / `whatsapp_order_draft_items` | — | SELECT | — |
| `profiles` | — | SELECT, UPDATE del propio (`auth.uid() = id`) | — |

## 7. Migraciones: cómo se trabaja

1. **Prisma Migrate con historial propio** desde `0001`. Las 27 migraciones de Supabase quedan como historia en `toki/supabase/migrations`, no se vuelven a aplicar.
2. **Crear:** `npm run db:migrate:create -- --name <nombre>` (`prisma migrate dev --create-only`, contra la base local). **Revisar el SQL** antes de aplicar: si Prisma propone borrar defaults, policies o índices parciales, se corrige a mano.
3. **SQL propio** (policies, funciones, triggers, CHECK, índices parciales) se escribe dentro de la migración, porque Prisma no lo modela.
4. **Aplicar en local:** `npm run db:migrate:deploy`. **Aplicar en producción:** automático en el entrypoint (`prisma migrate deploy` con `toki_owner`).
5. **Después de cada migración:** actualizar `schema.prisma` y correr `npm run db:generate`.
6. **Nunca editar una migración aplicada.**
7. **Toda tabla nueva con `business_id`** necesita: RLS habilitado, policies de SELECT y escritura, grants a `authenticated`/`service_role`, índice por `business_id`, trigger `set_updated_at` y test de aislamiento.

**Nota:** `pg_dump` 16.10+ agrega líneas `\restrict`/`\unrestrict` (comandos de psql). Se quitaron de `0001` porque rompen `prisma migrate deploy`; nunca pegar un dump sin limpiarlas.

**Verificación pendiente en la Mac** (en el sandbox no hay acceso a los binarios de Prisma): después de aplicar `0001`–`0007` en la base local, correr `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <url>`. Solo deben aparecer diferencias por los índices parciales documentados al final de `schema.prisma`.

## 8. Bootstrap de producción

`scripts/bootstrap-prod.sql` se corre **una vez como `toki_owner`, antes del primer deploy**:

```sql
create role toki_app login noinherit password '<openssl rand -hex 32>';
grant connect on database toki to toki_app;
```

**Orden:**

1. Crear `toki-db` en Dokploy (usuario `toki_owner`, sin puerto externo).
2. Correr el bootstrap desde la consola de Dokploy.
3. Primer deploy de `toki-api`: el entrypoint aplica todas las migraciones y `0002` otorga `anon`, `authenticated` y `service_role` a `toki_app`.
4. Verificar health y que `toki_app` tenga `rolsuper = f`, `rolbypassrls = f` y `rolinherit = f`.

**Gotcha de Lamelas:** si el rol no existe cuando corre la migración, no pongas una password del repo en `DATABASE_URL`. Creá el rol y volvé a correr el `GRANT`.

## 9. Migración de datos desde Supabase

**Objetivo:** mover datos, usuarios y archivos sin transformar ids, para que las FKs y los links sigan válidos.

**Ventana:** con pocos negocios piloto alcanza con 15-30 minutos en horario sin pedidos.

### 9.1 Preparación (días antes)

1. Infra de producción lista y con restore de backup probado.
2. **Ensayo completo** de la migración contra una base de staging en el VPS, con conteos por tabla.
3. Connection string de Supabase por **session pooler** (puerto 5432; la conexión directa es IPv6).
4. Buckets de R2 creados, con CORS y dominio público.

### 9.2 Ejecución (`npm run migrate:supabase`)

| Paso | Qué hace |
| --- | --- |
| 1. Freeze | El front muestra mantenimiento; pausar el workflow de n8n |
| 2. Usuarios | `select id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, last_sign_in_at, created_at from auth.users` → `auth.users` con `password_hash = encrypted_password` (bcrypt compatible) y `email_verified_at = email_confirmed_at` |
| 3. Datos | `pg_dump --data-only --schema=public` desde Supabase → restore con `session_replication_role = replica` (no dispara triggers: evita perfiles duplicados y `updated_at` pisados), en orden de dependencias |
| 4. Archivos | Lista `product-images`, `business-assets` y `payment-proofs` → sube a R2 conservando la key `<business_id>/...` (los dos primeros a `toki-public`, comprobantes a `toki-private`) |
| 5. URLs | Reescribe `businesses.logo_url`, `businesses.cover_url`, `categories.image_url`, `products.image_url` del host de Supabase a `R2_PUBLIC_URL`. `order_payment_proofs.storage_path` ya es una key y no cambia. Los defaults `/defaults/...` del front no se tocan |
| 6. Verificación | Conteo por tabla Supabase vs VPS; suma de `orders.total`; 5 imágenes al azar responden 200; login de un usuario real; menú público de cada negocio |
| 7. Corte | Front apuntando a la API; n8n con las URLs nuevas; smoke test de un pedido web, uno por WhatsApp y un cambio de estado en tiempo real |
| 8. Rollback | Supabase queda intacto en solo lectura una semana |

- **Idempotencia:** el script corta si la base destino no está vacía (salvo `--force`) y tiene `--dry-run`. `--only=users,data,storage,urls,verify` corre pasos sueltos.
- **Triggers apagados durante TODA la copia** (`session_replication_role = replica`), no solo durante los datos: copiar los usuarios dispara `handle_new_user` y duplica los perfiles (ver `docs/fases/fase7.md` §2).
- **Paso 0 obligatorio:** `npm run compare:schema` (script `scripts/compare-schema.ts`), que compara columnas, defaults, constraints, índices, policies, funciones, triggers y enums entre Supabase y la réplica. Es la verificación del hallazgo H1.
- **Probado** contra una base que simula Supabase (`auth.users` en su forma original y `storage.objects`): conteos, suma de `orders.total`, hashes `$2a$` conservados, URLs reescritas y fechas originales intactas.

## 10. Hallazgos al replicar

| # | Hallazgo | Impacto | Acción |
| --- | --- | --- | --- |
| H1 | `20260702233435_optimize_inventory_ingredient_policies.sql` crea policies que `20260702232816` ya creaba: el archivo local fue editado después de aplicarse | Confirma la deriva entre repo y remoto | Excluida del baseline. **Antes de migrar datos,** comparar la réplica con el schema real de Supabase (`pg_dump --schema-only` de producción vs `0001`) |
| H2 | `coupons` tiene SELECT para `anon`: cualquiera con la anon key puede listar cupones activos | Fuga menor | La API no expone la tabla; `POST /public/.../coupons/validate` valida sin listar. Evaluar quitar la policy en una migración posterior |
| H3 | `whatsapp_integrations` conserva columnas del proveedor Meta (`access_token_encrypted`, `verify_token`, `phone_number_id`, `waba_id`) | Ninguno | Se mantienen para migrar; se pueden limpiar después |
| H4 | El rol `staff` existe, pero no hay flujo para invitar miembros | Ninguno | Queda para roadmap (invitaciones, como en Lamelas) |
| H5 | `persist_order` y `create_manual_sale` comparaban el stock aunque `track_stock` fuera `false` (con `stock_quantity` en 0, el default de la tabla), y ponían `track_stock = true` al descontar | Un producto sin control de stock no se podía vender ("Stock insuficiente"), y el primero que se vendía quedaba controlando stock y se pausaba solo al llegar a cero. Hoy no se nota porque el panel activa `track_stock` siempre | Corregido en `0005` (checkout y POS) y `0007` (agente de WhatsApp). Para todo lo que ya lleva stock el comportamiento es idéntico |
| H6 | El dump del schema no trajo los grants que Supabase da de fábrica sobre el esquema `extensions` ni el EXECUTE de `business_is_open` para `anon` | El buscador del panel (`search_dashboard`, que corre con los permisos de quien llama) y el menú público fallaban con `permission denied` | Concedidos en `0004`. Revisar grants faltantes al comparar con producción (H1) |
