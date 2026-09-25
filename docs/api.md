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

## 2. `auth` ✅ implementado (F1)

| Método | Ruta | Auth | Body | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/register` | — | `{ fullName, email, password }` (8 caracteres a 72 bytes) | `201 { ok, message }` + email de verificación | `supabase.auth.signUp` |
| POST | `/auth/verify-email` | — | `{ token }` | `{ ok: true }` | Link de confirmación de Supabase |
| POST | `/auth/resend-verification` | — | `{ email }` | Siempre `{ ok, message }` | — |
| POST | `/auth/login` | — | `{ email, password }` | `Session` | `signInWithPassword` |
| POST | `/auth/refresh` | — | `{ refreshToken }` | `Session` (tokens nuevos) | Refresh automático de supabase-js |
| POST | `/auth/logout` | U | `{ refreshToken?, all?: boolean }` | `{ ok: true }` | `signOut` |
| POST | `/auth/forgot-password` | — | `{ email }` | Siempre `{ ok, message }` | `resetPasswordForEmail` |
| POST | `/auth/reset-password` | — | `{ token, password }` | `{ ok: true }` | `updateUser({ password })` |
| GET | `/auth/me` | U | Header opcional `X-Business-Id` | `{ user: { id, email, emailVerified }, profile: { fullName, phone, avatarUrl }, businesses: SessionBusiness[], currentBusiness: SessionBusiness \| null }` | `lib/auth.tsx` |

```ts
Session = {
  accessToken: string,          // JWT HS256, 15 min → header Authorization: Bearer
  refreshToken: string,         // opaco (64 hex), 30 días, de un solo uso
  expiresIn: 900,
  user: { id, email, fullName: string | null, emailVerified: true },
  businesses: SessionBusiness[]
}
SessionBusiness = { id, name, slug, logoUrl: string | null, isActive: boolean, role: "owner" | "admin" | "staff" }
```

**Links de los emails** (el front tiene que tener estas rutas):

- `${FRONT_URL}/verify-email?token=...` → `POST /auth/verify-email`
- `${FRONT_URL}/reset-password?token=...` → `POST /auth/reset-password`

**Rate limit:** 5/min por IP en `register`, `login`, `resend-verification`, `forgot-password` y `reset-password`.

**Errores:**

| Caso | Respuesta |
| --- | --- |
| Email o contraseña incorrectos (existan o no) | 401 `UNAUTHORIZED` "Email o contraseña incorrectos." |
| Contraseña correcta pero email sin verificar | 403 `EMAIL_NOT_VERIFIED` |
| Registro con email ya verificado | 409 `CONFLICT` |
| Token de email inválido, usado, vencido o de otro propósito | 400 `VALIDATION_ERROR` "El link no es válido o ya venció. Pedí uno nuevo." |
| Refresh inválido, vencido, revocado o de un usuario sin verificar | 401 |

**Reglas implementadas:**

- **Re-registrar una cuenta sin verificar** no pisa la contraseña (quien registra podría no ser el dueño del email): reenvía el link e invalida el anterior.
- **Pedir un link nuevo** (verificación o reset) invalida los anteriores del mismo tipo.
- **Refresh rotativo:** cada uso revoca el token y emite uno nuevo (`replaced_by`). Reusar un token rotado **dentro de 10 s** da 401 (dos pestañas refrescando a la vez). **Pasados 10 s**, se toma como robo y revoca todas las sesiones del usuario.
- **Reset de contraseña:** revoca todas las sesiones y marca el email como verificado (usar el link prueba acceso al email).
- **Logout:** solo revoca tokens propios.
- **Login:** con email inexistente igual se compara contra un hash de referencia, para no revelar qué emails existen por tiempo de respuesta.
- **Emails:** se envían después del commit, nunca dentro de la transacción.

**Services (`auth/service.ts`):** `register`, `verifyEmail`, `resendVerification`, `login`, `refresh`, `logout`, `forgotPassword`, `resetPassword`, `me`. **Repo (`auth/repo.ts`):** usuarios, tokens de email (consumo atómico), refresh tokens, membresías y perfil.

**Contexto BD:** `service_role` para `auth.*`; `authenticated` para membresías y perfil.

---

## 3. `account` ✅ implementado (F1)

| Método | Ruta | Auth | Body | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/me/profile` | U | — | `{ fullName, phone, avatarUrl, email }` | `AccountPage`: `profiles.select` |
| PATCH | `/me/profile` | U | `{ fullName?, phone? }` (al menos uno; nombre 2-120; teléfono ≤ 40; `""` borra el teléfono) | Perfil actualizado | `profiles.update` |

**Services:** `getProfile(ctx)` y `updateProfile(ctx, input)`. RLS: `profiles own select/update`.

---

## 4. `businesses` ✅ implementado (F2)

| Método | Ruta | Auth | Body / Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| POST | `/businesses` | U | `{ name, slug, phone?, address?, city?, description? }` | `201 { id, slug }` | Onboarding → RPC `create_business_with_owner` |
| GET | `/business` | M | — | `Business` (con `isOpen`) | `SettingsPages`, `ProductsPage` |
| PATCH | `/business` | A | Parcial: `{ name, slug, description, businessType, logoUrl, coverUrl, phone, whatsappPhone, address, city, timezone, estimatedDeliveryMinutes, minimumOrderAmount, deliveryFee, isActive }` | `Business` | `businesses.update` |
| PATCH | `/business/status` | A | `{ manualStatus: "auto" \| "open" \| "closed" }` | `{ manualStatus, isOpen }` | `businesses.update` |
| GET | `/business/hours` | M | — | `{ data: Hour[7] }` | `business_hours.select` |
| PUT | `/business/hours` | A | `{ hours: Hour[7] }` | `{ data: Hour[7] }` | `business_hours.upsert` |
| GET | `/business/special-hours` | M | `?from=YYYY-MM-DD` | `{ data: SpecialHour[] }` | `business_special_hours.select` |
| PUT | `/business/special-hours` | A | `{ specialHours: SpecialHour[] }` (**reemplaza todos**, igual que el front hoy) | `{ data }` | `delete` + `insert` |
| DELETE | `/business/special-hours/:id` | A | — | `204` | — |
| GET | `/business/checklist` | M | — | `{ slug, isActive, deliveryFee, minimumOrderAmount, openDays, activeCategories, availableProducts, hasLogo, hasCover, hasHours, hasPaymentMethod, hasCategories, hasProducts, whatsappConnected, completed }` | `OnboardingChecklist` (6 queries → 1) |

```ts
Business = { id, name, slug, description, businessType, logoUrl, coverUrl, phone, whatsappPhone, address, city,
             country, currency, timezone, estimatedDeliveryMinutes, minimumOrderAmount: number, deliveryFee: number,
             isActive, manualStatus, isOpen: boolean, createdAt, updatedAt }
Hour = { dayOfWeek: 0..6, isOpen, opensAt: "HH:mm" | null, closesAt, opensAt2, closesAt2 }
SpecialHour = { id?, date: "YYYY-MM-DD", isClosed, opensAt: "HH:mm" | null, closesAt, note }
```

**Reglas implementadas:**

- **Onboarding:** además de lo que crea la función (negocio, owner, `bot_settings`, 7 días de 19:00 a 23:30), crea `payment_settings` con efectivo y transferencia habilitados.
- **Slug:**
  - Formato kebab, 3 a 60 caracteres, normalizado a minúsculas.
  - Slug en uso → 409 "Ese link ya está en uso".
  - **Reservados** (chocan con rutas del front `/:businessSlug`): `login`, `register`, `onboarding`, `dashboard`, `forgot-password`, `reset-password`, `verify-email`, `api`, `admin`, `app`, `www`, `toki`, `static`, `assets`, `defaults`.
- **Imágenes (`logoUrl`, `coverUrl`):** solo se aceptan `null`, un asset por defecto del front (`/defaults/...`) o una URL de **nuestro bucket público dentro de la carpeta del negocio**. Al reemplazar una imagen, la anterior se borra de R2 después del commit.
- **Horarios:**
  - Los 7 días, cada uno una vez.
  - Si está abierto, apertura y cierre obligatorios; el segundo turno completo o vacío, y empezando después del cierre del primero.
  - Los días cerrados se guardan sin horas.
  - Se admiten cierres después de medianoche (`closesAt2: "00:30"`).
- **Horarios especiales:** fechas únicas; si está abierto, apertura y cierre obligatorios; hasta 200.
- **`X-Business-Id` ajeno:** 403 en cualquier ruta.

---

## 5. `settings` ✅ implementado (F2)

| Método | Ruta | Auth | Body | Origen |
| --- | --- | --- | --- | --- |
| GET | `/settings/payments` | M | — (sin fila devuelve los defaults) | `payment_settings.select` |
| PUT | `/settings/payments` | A | `{ cashEnabled, transferEnabled, transferCbu?, transferAlias?, transferHolder?, transferBank? }` | `payment_settings.upsert` |
| GET | `/settings/loyalty` | M | — | `loyalty_settings.select` |
| PUT | `/settings/loyalty` | A | `{ isEnabled, pointsPerCurrency, pointsPerOrder, redeemRate, minPointsToRedeem }` | `loyalty_settings.upsert` |
| GET | `/settings/bot` | M | — | `bot_settings` (hoy la pantalla es un mock) |
| PATCH | `/settings/bot` | A | `{ isEnabled?, botName?, tone?, fallbackMessage?, handoffEnabled? }` | — |
| GET | `/settings/bot/faqs` | M | — | `bot_faqs` |
| POST | `/settings/bot/faqs` | A | `{ question, answer, isActive? }` | — |
| PATCH | `/settings/bot/faqs/:id` | A | `{ question?, answer?, isActive? }` | — |
| DELETE | `/settings/bot/faqs/:id` | A | — | — |

**Reglas de pagos** (las mismas de `payment.schema.ts` del front):

- Al menos un medio habilitado.
- Con transferencia habilitada, CBU/CVU obligatorio.
- CBU/CVU: solo dígitos, de 6 a 22.
- Alias ≤ 40; titular y banco ≤ 80.
- `""` se guarda como `null`.
- `mercadopagoEnabled: true` → 400 "Mercado Pago todavía no está disponible".

**FAQs:** máximo 200 por negocio.

---

## 6. `coupons` ✅ implementado (F2)

| Método | Ruta | Auth | Body | Origen |
| --- | --- | --- | --- | --- |
| GET | `/coupons` | **A** | — | `coupons.select` |
| POST | `/coupons` | A | `{ code, description?, discountType: "percent" \| "fixed", discountValue, minimumOrderAmount?, startsAt?, endsAt?, usageLimit?, isActive? }` | `coupons.upsert` |
| PATCH | `/coupons/:id` | A | Mismos campos, opcionales | `coupons.upsert` |
| DELETE | `/coupons/:id` | A | — | `coupons.delete` (hoy sin filtro de negocio: queda resuelto) |

**Reglas:**

- `code`: se normaliza a mayúsculas, `[A-Z0-9-]`, 3 a 30 caracteres. Repetido en el negocio → 409; en otro negocio se permite.
- `discountValue > 0`; si es `percent`, ≤ 100.
- `endsAt ≥ startsAt`. El PATCH valida contra el **estado final** (por ejemplo, pasar a `percent` un cupón fijo de $900 → 400).
- **Fechas:** acepta `YYYY-MM-DD` (se toma 00:00 hora Argentina) o ISO completo; se devuelven en ISO UTC.
- **Borrar un cupón:** los pedidos que lo usaron conservan `coupon_code`.
- **`GET` solo para owner y admin:** la policy RLS le muestra a staff únicamente los cupones activos, así que su listado sería incompleto.

---

## 7. `catalog` ✅ implementado (F2)

### 7.1 Categorías

| Método | Ruta | Auth | Body | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/categories` | M | `?active=true\|false` | `{ data: Category[] }` con `products` y `availableProducts` | `categories.select` + conteos en el front |
| POST | `/categories` | A | `{ name, description?, imageUrl?, isActive?, sortOrder? }` (sin `sortOrder` va al final) | `201 Category` | `categories.insert` |
| PATCH | `/categories/:id` | A | Mismos campos, opcionales | `Category` | `categories.update` |
| PATCH | `/categories/reorder` | A | `{ ids: uuid[] }` (orden final; las no listadas quedan al final) | `{ data: Category[] }` | Updates de `sort_order` |
| DELETE | `/categories/:id` | A | — | `204` (los productos quedan sin categoría y se borra la imagen) | `categories.delete` |

### 7.2 Productos

| Método | Ruta | Auth | Body / Query | Origen |
| --- | --- | --- | --- | --- |
| GET | `/products` | M | `?categoryId=&available=&featured=&lowStock=true&search=&barcode=` | `ProductsPage`, `ManualSalePage` |
| GET | `/products/:id` | M | — | `ProductEditorPage` |
| POST | `/products` | A | `ProductInput` | `products.insert` + `product_options.insert` + `product_option_values.insert` |
| PUT | `/products/:id` | A | `ProductInput` (reemplazo completo) | `products.update` + delete/insert de opciones |
| PATCH | `/products/:id/availability` | A | `{ isAvailable }` | `products.update({ is_available })` |
| PATCH | `/products/:id/stock` | A | `{ stockQuantity, trackStock? }` | `products.update({ stock_quantity })` |
| DELETE | `/products/:id` | A | — | Borra producto, opciones e imagen en R2 |

```ts
ProductInput = {
  categoryId?: uuid | null, newCategoryName?: string,   // no las dos; la nueva se crea en la misma transacción
  name: string, description?: string | null, price: number, imageUrl?: string | null,
  isAvailable?: boolean (true), isFeatured?: boolean (false), preparationMinutes?: number | null,
  barcode?: string,                                     // si no viene: TKI-XXXXXXXXXX (en PUT se conserva)
  trackStock?: boolean (true), stockQuantity?: number (0), lowStockThreshold?: number (5), sortOrder?: number,
  options?: [{
    id?: uuid,                                          // mandar el id para conservarlo al editar
    name, type: "single" | "multiple", isRequired?: boolean, minSelect?: number, maxSelect?: number,
    values: [{ id?: uuid, name, priceDelta?: number, isAvailable?, trackStock?, stockQuantity?, lowStockThreshold? }]  // ≥ 1
  }]
}
Product = { ...campos, category: { id, name, isActive } | null, isLowStock: boolean, options: [...con ids y sortOrder] }
```

**Reglas implementadas:**

- **Transacción:** alta y edición en **una sola transacción** (categoría nueva, producto, opciones y valores). Si algo falla no queda nada a medias. Hoy el front hace escrituras sueltas.
- **Opciones con ids estables:** el PUT **sincroniza por id**. Actualiza lo que viene con id del mismo producto, crea lo nuevo y borra lo que no vino. Así los borradores de WhatsApp que guardan `option_value_ids` no se rompen al editar un producto. Ids de otro producto se ignoran y se crean nuevos.
- **Min/max:** mismas reglas que el editor del front. Si es obligatorio, `minSelect ≥ 1`; si no, 0. Si es `single`, `maxSelect = 1`.
- **Barcode:** único por negocio (409); el mismo código en otro negocio se permite.
- **Imágenes:** solo propias del negocio (ver §4). Al reemplazar o borrar, se elimina el objeto viejo de R2.
- **Stock bajo:** `isLowStock = trackStock && stockQuantity ≤ lowStockThreshold`.
- **Búsqueda:** `search` busca por nombre (sin distinguir mayúsculas) o barcode exacto.
- **Productos de otro negocio:** 404 en todas las rutas.

### 7.3 Ingredientes

| Método | Ruta | Auth | Body | Origen |
| --- | --- | --- | --- | --- |
| GET | `/ingredients` | M | `?lowStock=true` | `inventory_ingredients.select` |
| POST | `/ingredients` | A | `{ name, quantity, unit: "kg"\|"g"\|"l"\|"ml"\|"unit", lowStockThreshold, notes? }` | `insert` |
| PATCH | `/ingredients/:id` | A | Mismos campos, opcionales | `update` |
| DELETE | `/ingredients/:id` | A | — | `delete` |

Nombre único por negocio (409). Cantidades con hasta 3 decimales. Cada ítem trae `isLowStock` (`quantity ≤ lowStockThreshold`).

**Services (`catalog/`):**

- `categories.service.ts`: `list`, `create`, `update`, `reorder`, `remove`.
- `products.service.ts`: `list`, `get`, `create`, `replace`, `setAvailability`, `setStock`, `remove`, `syncOptions`.
- `ingredients.service.ts`: `list`, `create`, `update`, `remove`.

---

## 8. `uploads` ✅ implementado (F2)

| Método | Ruta | Auth | Body | Respuesta |
| --- | --- | --- | --- | --- |
| POST | `/uploads/presign` | A | `{ kind: "product" \| "category" \| "business-logo" \| "business-cover", contentType: "image/webp" \| "image/jpeg" \| "image/png" }` | `{ uploadUrl, method: "PUT", headers: { "Content-Type" }, key, publicUrl, expiresIn: 600 }` |

**Origen:** `storage.from("product-images" | "business-assets").upload(...)`.

**Flujo:**

1. El front pide la firma.
2. Hace `PUT uploadUrl` con el mismo `Content-Type`.
3. Guarda `publicUrl` en el recurso (`imageUrl`, `logoUrl` o `coverUrl`).

**Key:** `<business_id>/products|categories|business/logo|business/cover/<uuid>.<ext>`. La arma el backend con el negocio del contexto; el cliente no elige rutas.

**Sin credenciales de R2** (dev/test) devuelve URLs de stub y no sube nada.

### Nota de permisos para `staff` (RLS heredado)

Algunas policies de Supabase no incluyen a los miembros sin rol de administración:

- **Cupones:** solo ven los activos → por eso `GET /coupons` es solo para owner y admin.
- **`whatsapp_integrations`:** solo owner y admin → en el checklist, `whatsappConnected` siempre sale `false` para staff.
- **Horarios especiales, pagos y fidelización:** staff los ve solo si el negocio está activo (policy pública).

Si hace falta que staff vea algo de esto, se ajusta con una migración de policies y su test.

---

## 9. `orders` ✅ implementado (F3)

| Método | Ruta | Auth | Body / Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/orders` | M | `?status=&source=web\|whatsapp\|manual&from=&to=&search=&page=&limit=` | `{ data: [pedido con items, opciones, historial y pagos], meta: { page, limit, total, pages } }` | `OrdersPage` |
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
| `createManualSale(ctx, input)` | Resuelve nombres y recargos de cada opción contra la base y llama a `create_manual_sale`. **El mostrador manda ids, nunca precios** |
| `listPaymentProofs(ctx, orderId)` | Con URLs firmadas de `toki-private` |
| `reviewPaymentProof(ctx, id, status)` | Setea `status`, `reviewed_at` y `reviewed_by`. **No** marca el pedido pagado |
| `issueEventsTicket(ctx)` / `openEventStream(ticket, res)` | Ticket de un uso y suscripción al hub de `lib/realtime.ts` |

---

## 10. `customers` ✅ implementado (F3)

| Método | Ruta | Auth | Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/customers` | M | `?search=&page=&limit=` | `{ data: [{ id, name, phone, email, createdAt, ordersCount, ordersTotal, totalSpent, lastOrderAt, loyaltyPoints }], meta }` | `CustomersPage` (hoy agrega en el navegador) |
| GET | `/customers/:id` | M | — | Cliente + direcciones + últimos 20 pedidos | — |

**Services:** `list(ctx, filters)`, con agregados en SQL (`count`, `sum`, `max`), y `get(ctx, id)` (direcciones + últimos 20 pedidos).

`totalSpent` es el acumulado que mantiene `persist_order`; `ordersTotal` es la suma de los pedidos vigentes. No siempre coinciden (pedidos cancelados, ventas de mostrador anteriores al cliente) y el panel muestra los dos.

---

## 11. `dashboard` ✅ implementado (F3)

| Método | Ruta | Auth | Query | Respuesta | Origen |
| --- | --- | --- | --- | --- | --- |
| GET | `/dashboard/summary` | M | `?days=30` | `{ sales: { today, week, month }, orders: { today, pending, byStatus }, averageTicket, salesByDay: [{ date, total, count }], topProducts: [...], lowStock: { products, optionValues, ingredients }, recentOrders: [10], bot: { enabled }, conversationsCount }` | `DashboardPage` (hoy baja 30 días de pedidos y calcula en el navegador) |
| GET | `/dashboard/search` | M | `?q=` (≥ 2 caracteres) | `{ data: [{ id, group, title, detail, href, rank }] }` | RPC `search_dashboard` |

**Services:**

- `summary(ctx, days)`: agregados en SQL con la zona horaria del negocio.
- `search(ctx, q)`: `search_dashboard(business_id, q)`.

---

## 12. `whatsapp` ✅ implementado (F4)

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

## 13. `public` (clientes finales) ✅ implementado (F3)

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

## 14. `agent` (n8n) ✅ implementado (F4)

Todas con `X-Api-Key` (**K**). Cada request lleva `businessId` y `conversationId`, y las funciones SQL validan que la conversación sea del negocio. Las respuestas son el JSON que ya devuelven las RPC `agent_*`: el prompt del agente no cambia.

| Método | Ruta | Body / Query | SQL / acción | Origen en `toki-agent-v2.json` |
| --- | --- | --- | --- | --- |
| GET | `/agent/integrations/by-account/:accountId` | — | `whatsapp_integrations` activa → `{ businessId, business: {...}, botEnabled }` | `rest/v1/whatsapp_integrations` |
| POST | `/agent/conversations/upsert` | `{ businessId, contactId, phone? }` | Upsert por `(business_id, contact_id)`; no pisa `status` | `rest/v1/whatsapp_conversations` |
| POST | `/agent/messages` | `{ businessId, conversationId, direction, messageType, content?, providerMessageId?, rawPayload?, aiIntent? }` | Insert; devuelve `{ duplicate: false, id, createdAt }`, o `{ duplicate: true }` si `providerMessageId` ya existe | `rest/v1/whatsapp_messages` |
| GET | `/agent/conversations/:id` | `?businessId=` | `{ id, contactId, phone, status, handoffReason, lastMessageAt }`. El workflow lo relee antes de enviar: si una persona tomó la conversación, el bot se calla | `rest/v1/whatsapp_conversations?select=status` |
| GET | `/agent/conversations/:id/messages` | `?businessId=&after=&direction=&limit=50` | `{ data, count }`. Con `after` + `direction=inbound` responde "¿el cliente siguió escribiendo mientras esperábamos la ráfaga?" | `rest/v1/whatsapp_messages?created_at=gt.` |
| GET | `/agent/conversations/:id/context` | `?businessId=&k=20` | Primero descarta el borrador si pasaron 4 h sin cambios. Después `agent_context`, más (v3): `clock` (hora local, `is_open`, `closes_at`, `next_open: { at, label }`), `menu` (carta con ids cortos y opciones; `mode: full` hasta 50 productos, `summary` con más), `bot.bot_name` (Sofi por defecto) y `bot.tone_label`, `active_order.status_label` y `eta`, `business.menu_url` y `active_order.track_url` armados con `FRONT_URL` | `rpc/agent_context` |
| GET | `/agent/products/search` | `?businessId=&q=&limit=` | `agent_search_products` (v3: por palabras, sin acentos, tolera plurales y errores de tipeo) | `rpc/agent_search_products` |
| GET | `/agent/products/:id` | `?businessId=` | `agent_product_detail`. `:id` es el UUID o el id corto de la carta | `rpc/agent_product_detail` |
| GET | `/agent/faq/search` | `?businessId=&q=&limit=` | `agent_search_faq` (v3: por palabras) | `rpc/agent_search_faq` |
| GET | `/agent/orders/status` | `?businessId=&conversationId=&orderCode=` | `agent_order_status` | `rpc/agent_order_status` |
| GET | `/agent/draft` | `?businessId=&conversationId=` | `agent_draft_get` | `rpc/agent_draft_get` |
| POST | `/agent/draft/items` | `{ businessId, conversationId, productId, quantity, optionValueIds?, notes? }` o, en v3, `{ businessId, conversationId, items: [{ productId, quantity, optionValueIds?, notes? }] }` (hasta 20; también como texto JSON) | `agent_draft_add_item` por item. `productId` y `optionValueIds` aceptan UUID o id corto. Con `items` devuelve `{ ok, resultados: [{ producto, cantidad, ok, error? }], pedido }`: un item que falla no frena al resto | `rpc/agent_draft_add_item` |
| PATCH | `/agent/draft/items/:itemId` | `{ businessId, conversationId, quantity }` (0 a 50) | v3: cambia la cantidad validando stock del producto y de las opciones; 0 saca el item. Devuelve `{ ok, pedido }` | — |
| DELETE | `/agent/draft/items/:itemId` | `?businessId=&conversationId=` | `agent_draft_remove_item` | `rpc/agent_draft_remove_item` |
| PATCH | `/agent/draft` | `{ businessId, conversationId, customerName?, orderType?, deliveryAddress?, paymentMethod?, notes? }` | `agent_draft_set_details` (v3: pasar a `takeaway` borra la dirección) | `rpc/agent_draft_set_details` |
| DELETE | `/agent/draft` | `?businessId=&conversationId=` | `agent_draft_cancel` | — |
| POST | `/agent/draft/confirm` | `{ businessId, conversationId }` | `agent.confirmDraft`. v3: con el local cerrado por horario **toma el pedido** (queda `pending` con una nota en el historial) si abre en los próximos 7 días; cerrado a mano o sin horarios, `{ ok: false, error }`. La respuesta suma `para_la_apertura`, `abre`, `eta` (desde la apertura si está cerrado), `track_url` y `transferencia` si paga por transferencia | `functions/v1/create-order` (modo whatsapp) |
| PATCH | `/agent/orders` | `{ businessId, conversationId, orderCode?, orderType?, deliveryAddress?, paymentMethod? }` | `agent_order_update_details` | `rpc/agent_order_update_details` |
| POST | `/agent/orders/items` | `{ businessId, conversationId, orderCode? }` | `agent_order_add_draft_items` | `rpc/agent_order_add_draft_items` |
| POST | `/agent/conversations/:id/handoff` | `{ businessId, reason }` | `agent_conversation_handoff` | `rpc/agent_conversation_handoff` |
| POST | `/agent/payment-proofs` | `{ businessId, conversationId, mediaUrl, mediaType, orderCode?, providerMessageId? }` | Descarga de Zernio → R2 privado → `order_payment_proofs` | `storage/v1/object/payment-proofs` + `rest/v1/order_payment_proofs` |

**Ids cortos (v3).** La carta del contexto identifica cada producto y valor de opción con los primeros 6 caracteres de su UUID (8 si 6 chocan con otro id del negocio; el UUID completo si también chocan con 8). Las rutas que reciben un producto u opción aceptan el corto o el UUID y lo resuelven **dentro del negocio**: un id de otro negocio no se encuentra, y uno ambiguo vuelve como `{ ok: false, error }` legible.

`orderCode` va en el **cuerpo** y es opcional en las dos rutas de pedido confirmado: sin código, la función SQL resuelve el último pedido editable del contacto, que es el caso más común ("cambiame la dirección"). Con el código en la URL no había forma de expresarlo.

`paymentMethod` acepta `cash`, `transfer` y `mercadopago`: la validación de si el negocio lo tiene habilitado la hace la función SQL y vuelve como `{ ok: false, error }` legible, no como un 400.

**Services (`agent/service.ts`):**

| Función | Qué hace |
| --- | --- |
| `resolveIntegration(accountId)` | Negocio y estado del bot |
| `upsertConversation`, `logMessage` | Dedup por índice único parcial; captura `P2002` y devuelve `duplicate` |
| `getConversation`, `listMessages` | Estado de la conversación y mensajes con filtro `after`/`direction`: lo que el workflow necesita para el debounce de ráfagas y para no pisar a un humano |
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
| catalog | 16 (15 + reorder) |
| uploads | 1 |
| orders | 9 |
| customers | 2 |
| dashboard | 2 |
| whatsapp | 6 |
| agent | 20 |
| public | 5 |
| **Total** | **97** |
