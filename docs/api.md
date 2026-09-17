# Toki API — Especificación de endpoints

**Base URL:** `https://api.<dominio>/v1` · **Formato:** JSON · **Fecha:** 2026-09-17 · **Versión:** 1.0

**Referencias:**

- `arquitectura.md`: auth, contextos de BD, errores, realtime
- `base-de-datos.md`: tablas y funciones SQL

> **Columna "Origen":** qué hace hoy el front o n8n contra Supabase y queda reemplazado por el endpoint. Sirve de checklist para adaptar la capa de datos del front.

---

## 0. Convenciones

- **Versionado por path** (`/v1`). Un cambio breaking va a `/v2`.
- **JSON en `camelCase`** hacia afuera; la BD usa `snake_case` y el mapeo se hace en el repo.
- **Montos** como `number` (pesos, 2 decimales). **Fechas** en ISO 8601 UTC. **IDs** UUID. **Horas** `HH:mm`.
- **Paginación** (listados largos): `?page=1&limit=50` (máx. 100) → `{ data: [...], meta: { page, limit, total } }`.
- **Listas cortas** (categorías, horarios, FAQs): `{ data: [...] }` sin paginar.
- **Errores:** `{ error: { code, message, details? } }`. Códigos en `arquitectura.md` §10.

### Autenticación por tipo de ruta

| Marca | Significa | Contexto BD |
| --- | --- | --- |
| **—** | Pública | `anon` |
| **U** | `Authorization: Bearer <accessToken>` (usuario verificado) | `authenticated` |
| **M** | U + miembro del negocio actual (cualquier rol) | `authenticated` |
| **A** | U + rol `owner` o `admin` | `authenticated` |
| **O** | U + rol `owner` | `authenticated` |
| **K** | `X-Api-Key` del agente (n8n) | `service_role` |

**Negocio actual:** header opcional `X-Business-Id`; si falta, el primer negocio del usuario.

---

## 1. `health`

| Método | Ruta | Auth | Respuesta |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ ok: true, db: "up" \| "down", version }` |

**Service:** `check()`: `select 1` con timeout de 2 s.

---

## 2. `auth`

| Método | Ruta | Auth | Body | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/register` | — | `{ fullName, email, password }` (≥ 8) | `201 { ok: true }` + email de verificación | `supabase.auth.signUp` |
| POST | `/auth/verify-email` | — | `{ token }` | `{ ok: true }` | Link de confirmación de Supabase |
| POST | `/auth/resend-verification` | — | `{ email }` | Siempre `{ ok: true }` | — |
| POST | `/auth/login` | — | `{ email, password }` | `{ accessToken, refreshToken, expiresIn, user, businesses: [{ id, name, slug, role }] }` | `signInWithPassword` |
| POST | `/auth/refresh` | — | `{ refreshToken }` | Mismo shape que login (tokens nuevos) | Refresh automático de supabase-js |
| POST | `/auth/logout` | U | `{ refreshToken, all?: boolean }` | `{ ok: true }` | `signOut` |
| POST | `/auth/forgot-password` | — | `{ email }` | Siempre `{ ok: true }` | `resetPasswordForEmail` |
| POST | `/auth/reset-password` | — | `{ token, password }` | `{ ok: true }` (revoca todas las sesiones) | `updateUser({ password })` |
| GET | `/auth/me` | U | — | `{ user: { id, email }, profile: { fullName, phone }, businesses: [...], currentBusiness }` | `lib/auth.tsx` (profiles + business_members + businesses) |

**Rate limit:** `login`, `register`, `forgot-password` y `resend-verification`: 5/min por IP.

**Errores específicos:**

- `login` con email sin verificar → 403 `EMAIL_NOT_VERIFIED`.
- Credenciales inválidas → 401 genérico (no revela si el email existe).
- Refresh revocado reutilizado → 401 y revocación de toda la cadena.

**Services (`auth/service.ts`):**

| Función | Qué hace |
| --- | --- |
| `register(input)` | Normaliza el email; si existe y está verificado → 409; si existe sin verificar → reenvía verificación. Crea `auth.users` con bcrypt y `raw_user_meta_data.full_name` (el trigger crea `profiles`). Emite token `verify_email` (24 h). Envía el email después del commit |
| `verifyEmail(token)` | Valida hash, vencimiento y uso; marca `email_verified_at` y `used_at` |
| `resendVerification(email)` | Invalida tokens previos y emite uno nuevo si corresponde |
| `login(email, password, userAgent)` | Compara bcrypt, exige verificación, emite access + refresh, actualiza `last_login_at` |
| `refresh(token, userAgent)` | Rota el token; si ya estaba revocado, revoca la cadena |
| `logout(token, all, userId)` | Revoca uno o todos los refresh del usuario |
| `forgotPassword(email)` | Emite token `reset_password` (1 h) y envía email |
| `resetPassword(token, password)` | Cambia el hash, marca el token usado y revoca sesiones |
| `me(userId)` | Perfil + membresías con nombre y slug del negocio |

**Contexto BD:** `service_role` (las tablas de `auth` no son accesibles para `authenticated`).

---

## 3. `account`

| Método | Ruta | Auth | Body | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/me/profile` | U | — | `{ fullName, phone, email }` | `AccountPage`: `profiles.select` |
| PATCH | `/me/profile` | U | `{ fullName?, phone? }` (phone ≤ 40) | Perfil actualizado | `profiles.update` |

**Services:** `getProfile(ctx)` y `updateProfile(ctx, input)`. RLS: `profiles own select/update`.

---

## 4. `businesses`

| Método | Ruta | Auth | Body / Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| POST | `/businesses` | U | `{ name, slug, phone?, address?, city?, description? }` | `201 { id, slug }` | Onboarding → RPC `create_business_with_owner` |
| GET | `/business` | M | — | Negocio completo | `SettingsPages`, `ProductsPage` |
| PATCH | `/business` | A | `{ name?, slug?, description?, businessType?, logoUrl?, coverUrl?, phone?, whatsappPhone?, address?, city?, timezone?, estimatedDeliveryMinutes?, minimumOrderAmount?, deliveryFee?, isActive? }` | Negocio | `businesses.update` |
| PATCH | `/business/status` | A | `{ manualStatus: "auto" \| "open" \| "closed" }` | `{ manualStatus, isOpen }` | `businesses.update` |
| GET | `/business/hours` | M | — | `{ data: [{ dayOfWeek, isOpen, opensAt, closesAt, opensAt2, closesAt2 }] }` (7 filas) | `business_hours.select` |
| PUT | `/business/hours` | A | `{ hours: [7 filas] }` | `{ data }` | `business_hours.upsert` |
| GET | `/business/special-hours` | M | `?from=YYYY-MM-DD` | `{ data: [{ id, date, isClosed, opensAt, closesAt, note }] }` | `business_special_hours.select` |
| PUT | `/business/special-hours` | A | `{ specialHours: [...] }` (reemplaza las futuras) | `{ data }` | `delete` + `insert` |
| DELETE | `/business/special-hours/:id` | A | — | `204` | `business_special_hours.delete` |
| GET | `/business/checklist` | M | — | `{ hasLogo, hasCover, hasHours, hasPaymentMethod, activeCategories, availableProducts, whatsappConnected, deliveryConfigured, completed }` | `OnboardingChecklist` (6 queries) |

**Validaciones:**

- `slug` con `^[a-z0-9]+(?:-[a-z0-9]+)*$`; si ya existe → 409.
- `closes_at` y `opens_at` en pares; un cierre que cruza la medianoche es válido.

**Services (`businesses/service.ts`):**

| Función | Qué hace |
| --- | --- |
| `createWithOwner(ctx, input)` | Llama `create_business_with_owner` (crea negocio, owner, bot_settings y horarios) |
| `getCurrent(ctx)` / `update(ctx, input)` | Lectura y edición; al cambiar logo o portada borra el objeto anterior de R2 |
| `setManualStatus(ctx, status)` | Actualiza y devuelve `business_is_open(id)` |
| `getHours(ctx)` / `replaceHours(ctx, hours)` | Upsert de los 7 días en una transacción |
| `listSpecialHours` / `replaceSpecialHours` / `deleteSpecialHour` | — |
| `getChecklist(ctx)` | Una query agregada |

---

## 5. `settings`

| Método | Ruta | Auth | Body | Origen |
| --- | --- | --- | --- | --- |
| GET | `/settings/payments` | M | — | `payment_settings.select` |
| PUT | `/settings/payments` | A | `{ cashEnabled, transferEnabled, transferAlias?, transferCbu?, transferHolder?, transferBank?, mercadopagoEnabled }` | `payment_settings.upsert` |
| GET | `/settings/loyalty` | M | — | `loyalty_settings.select` |
| PUT | `/settings/loyalty` | A | `{ isEnabled, pointsPerCurrency, pointsPerOrder, redeemRate, minPointsToRedeem }` | `loyalty_settings.upsert` |
| GET | `/settings/bot` | M | — | `bot_settings` (hoy la pantalla es un mock) |
| PATCH | `/settings/bot` | A | `{ isEnabled?, botName?, tone?, fallbackMessage?, handoffEnabled? }` | — |
| GET | `/settings/bot/faqs` | M | — | `bot_faqs` |
| POST | `/settings/bot/faqs` | A | `{ question, answer, isActive? }` | — |
| PATCH | `/settings/bot/faqs/:id` | A | `{ question?, answer?, isActive? }` | — |
| DELETE | `/settings/bot/faqs/:id` | A | — | — |

**Validaciones de pagos** (espejo de los CHECK):

- Alias ≤ 80, CBU/CVU entre 6 y 40, titular y banco ≤ 120.
- Al menos un medio habilitado.
- `mercadopagoEnabled` se rechaza con 400 mientras no exista la integración.

**Services:** `getPaymentSettings`, `upsertPaymentSettings`, `getLoyalty`, `upsertLoyalty`, `getBotSettings`, `updateBotSettings`, `listFaqs`, `createFaq`, `updateFaq`, `deleteFaq`.

---

## 6. `coupons`

| Método | Ruta | Auth | Body | Origen |
| --- | --- | --- | --- | --- |
| GET | `/coupons` | M | — | `coupons.select` |
| POST | `/coupons` | A | `{ code, description?, discountType: "percent" \| "fixed", discountValue, minimumOrderAmount?, startsAt?, endsAt?, usageLimit?, isActive? }` | `coupons.upsert` |
| PATCH | `/coupons/:id` | A | Mismos campos, opcionales | `coupons.upsert` |
| DELETE | `/coupons/:id` | A | — | `coupons.delete` (hoy sin filtro de negocio: queda resuelto) |

**Reglas:**

- `code` en mayúsculas `[A-Z0-9-]` y único por negocio (409).
- `percent` ≤ 100.
- `endsAt ≥ startsAt`.

**Services:** `list`, `create`, `update`, `remove`.

---

## 7. `catalog`

### 7.1 Categorías

| Método | Ruta | Auth | Body | Origen |
| --- | --- | --- | --- | --- |
| GET | `/categories` | M | `?active=true\|false` | `categories.select` |
| POST | `/categories` | A | `{ name, description?, imageUrl?, isActive?, sortOrder? }` | `categories.insert` |
| PATCH | `/categories/:id` | A | Mismos campos, opcionales | `categories.update` |
| PATCH | `/categories/reorder` | A | `{ ids: [uuid...] }` (orden final) | Updates de `sort_order` |
| DELETE | `/categories/:id` | A | — | `categories.delete` (los productos quedan sin categoría: `SET NULL`) |

### 7.2 Productos

| Método | Ruta | Auth | Body / Query | Origen |
| --- | --- | --- | --- | --- |
| GET | `/products` | M | `?categoryId=&available=&search=&lowStock=true&barcode=` | `ProductsPage`, `ManualSalePage` (con opciones y valores) |
| GET | `/products/:id` | M | — | `ProductEditorPage` |
| POST | `/products` | A | `ProductInput` | `products.insert` + `product_options.insert` + `product_option_values.insert` |
| PUT | `/products/:id` | A | `ProductInput` (reemplaza opciones) | `products.update` + delete/insert de opciones |
| PATCH | `/products/:id/availability` | A | `{ isAvailable }` | `products.update({ is_available })` |
| PATCH | `/products/:id/stock` | A | `{ stockQuantity, trackStock? }` | `products.update({ stock_quantity })` |
| DELETE | `/products/:id` | A | — | Borra el producto y su imagen en R2 |

```ts
ProductInput = {
  categoryId?: uuid | null, newCategoryName?: string,   // crear categoría al vuelo (ProductEditorPage)
  name: string, description?: string, price: number, imageUrl?: string | null,
  isAvailable?: boolean, isFeatured?: boolean, preparationMinutes?: number | null,
  barcode?: string, trackStock?: boolean, stockQuantity?: number, lowStockThreshold?: number, sortOrder?: number,
  options: [{
    name: string, type: "single" | "multiple", isRequired: boolean, minSelect: number, maxSelect: number,
    values: [{ name: string, priceDelta: number, isAvailable?: boolean, trackStock?: boolean, stockQuantity?: number, lowStockThreshold?: number }]
  }]
}
```

- Alta y edición en **una sola transacción**: hoy son 3 escrituras sueltas y un fallo intermedio deja opciones a medias.
- `barcode` único por negocio, entre 4 y 64 caracteres; si no se manda, lo genera el default SQL (`TKI-XXXXXXXXXX`).
- `maxSelect ≥ minSelect` y `maxSelect ≥ 1`.

### 7.3 Ingredientes (stock de insumos)

| Método | Ruta | Auth | Body | Origen |
| --- | --- | --- | --- | --- |
| GET | `/ingredients` | M | `?lowStock=true` | `inventory_ingredients.select` |
| POST | `/ingredients` | A | `{ name, quantity, unit: "kg"\|"g"\|"l"\|"ml"\|"unit", lowStockThreshold, notes? }` | `insert` |
| PATCH | `/ingredients/:id` | A | Mismos campos, opcionales | `update` |
| DELETE | `/ingredients/:id` | A | — | `delete` |

**Services (`catalog/`):**

| Service | Funciones |
| --- | --- |
| `categories.service.ts` | `list`, `create`, `update`, `reorder` (una transacción), `remove` (borra la imagen de R2) |
| `products.service.ts` | `list(filters)`, `get`, `create(input)`, `replace(id, input)`, `setAvailability`, `setStock`, `remove` |
| `ingredients.service.ts` | `list`, `create`, `update`, `remove` |

---

## 8. `uploads`

| Método | Ruta | Auth | Body | Respuesta |
| --- | --- | --- | --- | --- |
| POST | `/uploads/presign` | A | `{ kind: "product" \| "category" \| "business-logo" \| "business-cover", contentType: "image/webp" \| "image/jpeg" \| "image/png" }` | `{ uploadUrl, key, publicUrl, expiresIn: 600 }` |

**Origen:** `storage.from("product-images" | "business-assets").upload(...)`.

**Services:**

- `presignImage(ctx, kind, contentType)`: arma la key `<business_id>/<carpeta>/<uuid>.<ext>` y firma un PUT.
- `deleteObject(key)`: lo usan catalog y businesses al reemplazar imágenes.

**Seguridad:** la key siempre la genera el backend con el `businessId` del contexto; el cliente no elige rutas.

---

## 9. `orders`

| Método | Ruta | Auth | Body / Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/orders` | M | `?status=&source=web\|whatsapp\|manual&from=&to=&search=&page=&limit=` | Pedidos con items, opciones, historial y pagos | `OrdersPage` |
| GET | `/orders/:id` | M | — | Pedido completo (+ `barcode` de cada producto) | `refreshOrder` |
| PATCH | `/orders/:id/status` | M | `{ status, note? }` | Pedido | RPC `update_order_status` |
| POST | `/orders/:id/mark-paid` | M | — | Pedido | RPC `mark_order_paid` |
| POST | `/orders/manual` | M | `ManualSaleInput` | `201` pedido creado | RPC `create_manual_sale` (POS) |
| GET | `/orders/:id/payment-proofs` | M | — | `{ data: [{ id, status, mediaType, createdAt, reviewedAt, url }] }` (`url` firmada, 10 min) | `order_payment_proofs` + `createSignedUrl` |
| PATCH | `/payment-proofs/:id` | M | `{ status: "approved" \| "rejected" }` | Comprobante | `order_payment_proofs.update` |
| POST | `/orders/events/ticket` | M | — | `{ ticket, expiresIn: 60 }` | — |
| GET | `/orders/events` | ticket | `?ticket=` | `text/event-stream`: `order` `{ orderId, op }` · `resync` · ping | `supabase.channel(...)` en `OrdersPage` y `DashboardShell` |

```ts
ManualSaleInput = {
  customerName?: string, customerPhone?: string,
  paymentMethod: "cash" | "transfer", discountTotal?: number,
  items: [{ productId: uuid, quantity: number, notes?: string | null,
            options: [{ optionId: uuid, valueIds: uuid[] }] }]
}
```

**Services (`orders/service.ts`):**

| Función | Qué hace |
| --- | --- |
| `list(ctx, filters)` | Filtros por estado, origen, rango de fechas y texto (código, nombre, teléfono) |
| `get(ctx, id)` | Pedido con relaciones; 404 si RLS lo oculta |
| `changeStatus(ctx, id, status, note)` | `update_order_status` (valida membresía y escribe historial) |
| `markPaid(ctx, id)` | `mark_order_paid` |
| `createManualSale(ctx, input)` | `create_manual_sale` (stock, descuento, medio de pago, código) |
| `listPaymentProofs(ctx, orderId)` | Con URLs firmadas de `toki-private` |
| `reviewPaymentProof(ctx, id, status)` | Setea `status`, `reviewed_at` y `reviewed_by`. **No** marca el pedido pagado |
| `issueEventsTicket(ctx)` / `openEventStream(ticket, res)` | Ticket de un uso y suscripción al hub de `lib/realtime.ts` |

---

## 10. `customers`

| Método | Ruta | Auth | Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/customers` | M | `?search=&page=&limit=` | `{ data: [{ id, name, phone, email, createdAt, addresses, ordersCount, totalSpent, lastOrderAt, loyaltyPoints }], meta }` | `CustomersPage` (hoy agrega en el navegador) |
| GET | `/customers/:id` | M | — | Cliente + direcciones + últimos 20 pedidos | — |

**Services:** `list(ctx, filters)`, con agregados en SQL (`count`, `sum`, `max`), y `get(ctx, id)`.

---

## 11. `dashboard`

| Método | Ruta | Auth | Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/dashboard/summary` | M | `?days=30` | `{ sales: { today, week, month }, orders: { today, pending, byStatus }, averageTicket, salesByDay: [{ date, total, count }], topProducts: [...], lowStock: { products, optionValues, ingredients }, recentOrders: [10], bot: { enabled }, conversationsCount }` | `DashboardPage` (hoy baja 30 días de pedidos y calcula en el navegador) |
| GET | `/dashboard/search` | M | `?q=` (≥ 2 caracteres) | `{ data: [{ id, group, title, detail, href, rank }] }` | RPC `search_dashboard` |

**Services:**

- `summary(ctx, days)`: agregados en SQL con la zona horaria del negocio.
- `search(ctx, q)`: `search_dashboard(business_id, q)`.

---

## 12. `whatsapp`

| Método | Ruta | Auth | Body / Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/whatsapp/integration` | A | — | `{ provider, isActive, phoneNumber, connectedAt }` (sin tokens) | `whatsapp_integrations.select` |
| POST | `/whatsapp/connect/start` | A | `{ redirectUrl, onboarding?: "business_app" \| "api" }` | `{ authUrl, state, profileId }` | Edge `zernio-whatsapp-start` |
| POST | `/whatsapp/connect/complete` | A | `{ profileId, accountId, username?, rawQuery? }` | `{ success: true, integration }` | Edge `zernio-whatsapp-complete` |
| GET | `/conversations` | M | `?status=open\|handoff\|closed&page=` | Conversaciones con cliente, orden por `lastMessageAt` | `ConversationsPage` |
| GET | `/conversations/:id/messages` | M | `?before=&limit=50` | `{ data: messages, lastOrder: { orderCode, status, total } \| null }` | `whatsapp_messages.select` + `orders` por teléfono |
| PATCH | `/conversations/:id/status` | M | `{ status: "open" \| "handoff" \| "closed" }` | Conversación | Botón Tomar/Devolver (`whatsapp_conversations.update`) |

**Services:**

| Función | Qué hace |
| --- | --- |
| `getIntegration(ctx)` | Lectura sin campos sensibles |
| `startZernioConnect(ctx, input)` | Rechaza integraciones legacy (`provider = meta`), crea o reutiliza el profile de Zernio, guarda metadata (`is_active = false`) y pide la URL de conexión |
| `completeZernioConnect(ctx, input)` | Valida que el `profileId` coincida con el iniciado y activa la integración con `provider_external_id = accountId` |
| `listConversations`, `listMessages`, `setConversationStatus` | Al pasar a `open` limpia `handoff_reason`; al tomar, usa `pedido_humano` si no había motivo |

**Contexto BD:** `authenticated` para lecturas. La escritura de la integración usa `service_role` después de validar el rol, igual que la Edge Function.

---

## 13. `public` (clientes finales)

| Método | Ruta | Auth | Body / Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/public/businesses/:slug` | — | — | `{ business, isOpen, hours, specialHours (próximos 14 días), categories, products (con opciones y valores disponibles), paymentMethods: { cash, transfer, transferDetails? }, loyalty }` | `PublicMenuPage` + `CheckoutPage` (6 queries) |
| GET | `/public/businesses/:slug/products/:id` | — | — | Producto disponible con opciones | `ProductDetailPage` |
| POST | `/public/businesses/:slug/coupons/validate` | — | `{ code, subtotal }` | `{ valid: true, code, discountType, discountValue, discountTotal }` o 400 con motivo | Hoy el checkout lee `coupons` directo |
| POST | `/public/businesses/:slug/orders` | — | `CheckoutInput` | `201 { id, orderCode, status, total, discountTotal, loyaltyPointsEarned }` | Edge `create-order` |
| GET | `/public/businesses/:slug/orders/:code` | — | — | Contrato de `get_public_order` (sin datos privados) | RPC `get_public_order` |

```ts
CheckoutInput = {
  customer: { name: string, phone: string },
  orderType: "delivery" | "takeaway",
  deliveryAddress?: string,            // obligatorio si delivery
  notes?: string, couponCode?: string,
  paymentMethod: "cash" | "transfer",  // mercadopago rechazado mientras no esté integrado
  items: [{ productId: uuid, quantity: 1..50, optionValueIds?: uuid[], notes?: string }]
}
```

**Rate limit:** GET 120/min por IP; `orders` y `coupons/validate` 20/min por IP.

**Services:**

| Función | Qué hace |
| --- | --- |
| `getMenu(slug)` | Negocio activo + catálogo disponible (policies públicas, contexto `anon`) + `business_is_open` |
| `getProduct(slug, id)` | — |
| `validateCoupon(slug, code, subtotal)` | Mismas reglas que el checkout; no revela cupones inexistentes con otro mensaje |
| `createOrder(slug, input)` | Negocio activo → `business_is_open` (409 `BUSINESS_CLOSED`) → `orderPricing.build(...)` → `persist_order` (`service_role`) → `NOTIFY` automático por trigger |
| `trackOrder(slug, code)` | `get_public_order(code)` y verificación de que pertenece al slug |

**Módulo compartido `orders/pricing.ts`:** port de `buildOrderPayload` de la Edge Function. Es el **único** lugar donde se calcula un total, y lo usan `public.createOrder` y `agent.confirmDraft`.

- **Medio de pago:** habilitado en `payment_settings`.
- **Productos:** existen, son del negocio y están disponibles.
- **Cantidades:** entre 1 y 50; stock del producto y de cada valor elegido.
- **Opciones:** `minSelect`/`maxSelect`/obligatorias; valores disponibles y conocidos.
- **Precio unitario:** `price + Σ priceDelta`.
- **Totales:** subtotal ≥ mínimo; envío si es delivery; cupón (vigencia, usos, mínimo; `percent` o `fixed`, tope el subtotal).
- **Código de pedido:** `TK-XXXXXX` único.

---

## 14. `agent` (n8n)

Todas con `X-Api-Key` (**K**). Cada request lleva `businessId` y `conversationId`, y las funciones SQL validan que la conversación sea del negocio. Las respuestas son el JSON que ya devuelven las RPC `agent_*`: el prompt del agente no cambia.

| Método | Ruta | Body / Query | SQL / acción | Origen en `toki-agent-v2.json` |
| --- | --- | --- | --- | --- |
| GET | `/agent/integrations/by-account/:accountId` | — | `whatsapp_integrations` activa → `{ businessId, business: {...}, botEnabled }` | `rest/v1/whatsapp_integrations` |
| POST | `/agent/conversations/upsert` | `{ businessId, contactId, phone? }` | Upsert por `(business_id, contact_id)`; no pisa `status` | `rest/v1/whatsapp_conversations` |
| POST | `/agent/messages` | `{ businessId, conversationId, direction, messageType, content?, providerMessageId?, rawPayload?, aiIntent? }` | Insert; si `providerMessageId` ya existe → `200 { duplicate: true }` | `rest/v1/whatsapp_messages` |
| GET | `/agent/conversations/:id/context` | `?businessId=&k=20` | `agent_context` | `rpc/agent_context` |
| GET | `/agent/products/search` | `?businessId=&q=&limit=` | `agent_search_products` | `rpc/agent_search_products` |
| GET | `/agent/products/:id` | `?businessId=` | `agent_product_detail` | `rpc/agent_product_detail` |
| GET | `/agent/faq/search` | `?businessId=&q=&limit=` | `agent_search_faq` | `rpc/agent_search_faq` |
| GET | `/agent/orders/status` | `?businessId=&conversationId=&orderCode=` | `agent_order_status` | `rpc/agent_order_status` |
| POST | `/agent/draft/items` | `{ businessId, conversationId, productId, quantity, optionValueIds?, notes? }` | `agent_draft_add_item` | `rpc/agent_draft_add_item` |
| DELETE | `/agent/draft/items/:itemId` | `?businessId=&conversationId=` | `agent_draft_remove_item` | `rpc/agent_draft_remove_item` |
| PATCH | `/agent/draft` | `{ businessId, conversationId, customerName?, orderType?, deliveryAddress?, paymentMethod?, notes? }` | `agent_draft_set_details` | `rpc/agent_draft_set_details` |
| DELETE | `/agent/draft` | `?businessId=&conversationId=` | `agent_draft_cancel` | — |
| POST | `/agent/draft/confirm` | `{ businessId, conversationId }` | `agent.confirmDraft` | `functions/v1/create-order` (modo whatsapp) |
| PATCH | `/agent/orders/:orderCode` | `{ businessId, conversationId, orderType?, deliveryAddress?, paymentMethod? }` | `agent_order_update_details` | `rpc/agent_order_update_details` |
| POST | `/agent/orders/:orderCode/items` | `{ businessId, conversationId }` | `agent_order_add_draft_items` | `rpc/agent_order_add_draft_items` |
| POST | `/agent/conversations/:id/handoff` | `{ businessId, reason }` | `agent_conversation_handoff` | `rpc/agent_conversation_handoff` |
| POST | `/agent/payment-proofs` | `{ businessId, conversationId, mediaUrl, mediaType, orderCode? }` | Descarga de Zernio → R2 privado → `order_payment_proofs` | `storage/v1/object/payment-proofs` + `rest/v1/order_payment_proofs` |

**Services (`agent/service.ts`):**

| Función | Qué hace |
| --- | --- |
| `resolveIntegration(accountId)` | Negocio y estado del bot |
| `upsertConversation`, `logMessage` | Dedup por índice único parcial; captura `P2002` y devuelve `duplicate` |
| `context`, `searchProducts`, `productDetail`, `searchFaq`, `orderStatus` | Wrappers de lectura |
| `draftAddItem`, `draftRemoveItem`, `draftSetDetails`, `draftCancel` | Wrappers de borrador |
| `confirmDraft(businessId, conversationId)` | Borrador abierto; si ya está confirmado devuelve el pedido (idempotente). Valida nombre, tipo, pago y dirección; negocio abierto. Arma el input con los items del borrador (sin precios del cliente) → `pricing.build` → `persist_order(source: "whatsapp", conversationId)` → marca el borrador `confirmed`. Los errores vuelven como `{ ok: false, error }` legible para el agente |
| `updateOrderDetails`, `addDraftItemsToOrder`, `handoff` | Wrappers de pedido y handoff |
| `savePaymentProof(input)` | Descarga el adjunto con `Authorization: Bearer ZERNIO_API_KEY` (máx. 10 MB, tipos imagen/PDF). Key `<business_id>/payment-proofs/<order_code \| sin-pedido>/<uuid>.<ext>`. Solo inserta la fila si hay pedido resuelto. Idempotente por `providerMessageId` |

---

## 15. Resumen de rutas

| Módulo | Rutas |
| --- | --- |
| health | 1 |
| auth | 9 |
| account | 2 |
| businesses | 10 |
| settings | 10 |
| coupons | 4 |
| catalog | 16 |
| uploads | 1 |
| orders | 9 |
| customers | 2 |
| dashboard | 2 |
| whatsapp | 6 |
| public | 5 |
| agent | 17 |
| **Total** | **94** |
