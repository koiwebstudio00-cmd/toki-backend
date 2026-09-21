# Fase 6 — El front deja Supabase

**Ramas:** `fase6` en `toki-api` (este doc + un ajuste chico) y `fase6` en `toki` (la migración) · **Fecha:** 2026-09-19

Esta fase toca el **otro repo**: `toki-platform/toki`, el front. Es la única que se commitea afuera de `toki-api`, así que tiene su propia rama `fase6` allá, salida de `dev`.

Resultado: **no queda una sola llamada a Supabase en el front**. La dependencia `@supabase/supabase-js` y `src/lib/supabase/` se eliminaron.

---

## 1. El cliente nuevo: `src/lib/api/`

Dos archivos reemplazan a supabase-js.

### `client.ts`

Se ocupa de lo que antes hacía la librería:

- **Sesión.** Guarda access y refresh token, y los manda en cada request. El negocio actual viaja en `X-Business-Id`.
- **Refresh automático.** Si el access token venció, lo renueva y reintenta la request una sola vez, sin que la pantalla se entere. Si varias requests caen a la vez, se hace **un solo refresh** (el token es de un solo uso y dos refreshes en paralelo se pisan).
- **Sesión caída.** Cuando el refresh deja de servir, limpia todo y avisa por `onSessionChange`; `AuthProvider` manda al login.
- **Errores con código.** `ApiError` trae `code` (`EMAIL_NOT_VERIFIED`, `NOT_FOUND`, `CONFLICT`...), así las pantallas deciden por el código y no por el texto.
- **SSE.** `openOrdersStream()` pide el ticket de un uso y abre el stream de pedidos en vivo.

### La capa de compatibilidad de nombres

La API usa camelCase; el front heredó snake_case de las columnas de Supabase (`price_delta`, `is_available`, `order_items`). En vez de renombrar medio front, el cliente **traduce las claves en los dos sentidos**: lo que sale va en camelCase y lo que entra vuelve en snake_case.

Es a propósito, y está marcado como tal en el código: el día que el front use camelCase se borran dos funciones y el resto no se entera. Sin esto, la migración hubiera tocado cada componente en vez de cada llamada.

Además hay dos adaptadores de forma, porque la API agrupa distinto que Supabase:

- `toFrontProduct`: `options[].values[]` → `product_options[].product_option_values[]`
- `toFrontOrder`: `items` → `order_items`, `status_history` → `order_status_history`, `item.barcode` → `item.products.barcode` (lo usa el ticket impreso)

### `index.ts`

Los endpoints agrupados por pantalla: `auth`, `account`, `business`, `settings`, `coupons`, `categories`, `products`, `ingredients`, `orders`, `customers`, `dashboard`, `whatsapp`, `publicMenu`, más `uploadImage`.

---

## 2. Qué cambió en cada pantalla

| Pantalla | Antes | Ahora |
| --- | --- | --- |
| `auth.tsx` | `supabase.auth` + 3 consultas para el perfil y el negocio | `GET /auth/me`, una request |
| `AuthPages` | signUp / signInWithPassword | Registro con verificación de email, login, reset con el token del link |
| **nueva** `/verify-email` | — | Página que consume el link del mail |
| `OnboardingPage` | RPC `create_business_with_owner` | `POST /businesses` y recarga de sesión (sin `window.location.reload()`) |
| `OrdersPage` | `supabase.channel` + 2 queries anidadas | `GET /orders` + **SSE**; los eventos traen solo ids y el pedido se vuelve a pedir |
| `DashboardShell` | canal de INSERT para el sonido | SSE |
| `DashboardPage` | canal + 4 queries | `GET /orders` con rango + `GET /products` + `GET /dashboard/summary` |
| `OrderDetailSheet` | tabla de comprobantes + `createSignedUrl` por cada uno | `GET /orders/:id/payment-proofs` con las URLs **ya firmadas** |
| `OrderStatusPage` | RPC `get_public_order` | `GET /public/businesses/:slug/orders/:code` (valida que el pedido sea de ese negocio) |
| `PublicMenuPage` | 5 consultas | 1 request |
| `CheckoutPage` | 6 consultas + Edge Function + **la lista de cupones bajada al navegador** | 1 request para el menú, cupón validado contra la API, `POST .../orders` |
| `ProductEditorPage` | insert de producto + delete/insert de opciones (3 escrituras sueltas) | 1 request, 1 transacción, conservando los ids de las opciones |
| `ProductsPage`, `CategoriesPage`, `IngredientsPage` | CRUD directo a las tablas | Endpoints del módulo |
| `ManualSalePage` | RPC `create_manual_sale` con nombres y **recargos desde el navegador** | `POST /orders/manual` con solo ids |
| `ConversationsPage` | 3 consultas | `GET /conversations` + `GET /conversations/:id/messages` (mensajes y último pedido juntos) |
| `CustomersPage` | todos los pedidos al navegador para sumarlos | `GET /customers` con los totales calculados en SQL |
| `SettingsPages` | 19 llamadas a Supabase | Endpoints de `business` y `settings` |
| `Topbar` | RPC `search_dashboard` | `GET /dashboard/search` |
| Imágenes | `storage.upload` a dos buckets | URL prefirmada de R2; la ruta la decide el backend |

### Dos cosas que además quedaron mejor

**El checkout ya no se baja los cupones.** Antes el navegador recibía todos los cupones activos del negocio (con sus límites de uso) y decidía solo. Ahora manda el código a `POST /coupons/validate` mientras el cliente escribe, y el descuento lo calcula el backend.

**El POS ya no manda precios.** Mandaba `priceDelta` de cada opción desde el navegador y la función SQL le creía. Ahora manda ids y los recargos salen de la base.

---

## 3. Verificación

```
npx tsc -b --force   → sin errores
npx eslint .         → 0 errores (2 warnings de react-refresh que ya estaban)
```

El bundle (`npm run build`) **no lo pude correr yo**: el entorno donde trabajo no tiene el binario nativo de rollup para esta plataforma. El chequeo de tipos, que es donde aparecerían los errores de la migración, sí pasa completo. Corré `npm run build` en tu Mac como primer paso de la prueba manual.

En `toki-api` esta fase suma un solo cambio: `GET /customers` ahora devuelve `lastAddress` (la última dirección que usó el cliente), que es lo que la tabla de clientes muestra como "dirección principal". Con su test. Además quedó determinista un test de horarios que dependía de la hora a la que se corría (entre las 00:00 y las 00:30 el turno de ayer que cierra a las 00:30 mantiene abierto el negocio), y se agregó un test que cubre justamente ese caso. **229 tests en verde**.

---

## 4. Cómo probarlo a mano

### Levantar las dos partes

```bash
# Terminal 1 — API
cd ~/koi/toki-platform/toki-api
git checkout fase6
npm run db:migrate:deploy && npm run seed
npm run dev                       # http://localhost:3000

# Terminal 2 — front
cd ~/koi/toki-platform/toki
git checkout fase6
npm install                       # se fue @supabase/supabase-js
echo "VITE_API_URL=http://localhost:3000" >> .env
npm run build                     # primero: que compile
npm run dev                       # http://localhost:5173
```

Si `.env` ya tenía `VITE_SUPABASE_URL`, podés borrar esas líneas: ya no se leen.

### El recorrido completo

1. **Registro.** Creá una cuenta nueva. Tiene que decir "confirmá tu email" y **no** dejarte entrar. El mail sale por consola de la API (sin SMTP configurado): copiá el link `/verify-email?token=...`, abrilo y después entrá.
2. **Login sin verificar.** Registrá otra cuenta y probá entrar sin confirmar: mensaje claro y reenvío automático del link.
3. **Onboarding.** Con la cuenta nueva, creá el negocio. Probá un slug repetido (`toki-demo`): tiene que avisar que está en uso.
4. **Sesión.** Recargá la página: tenés que seguir adentro. El access token dura 15 minutos; dejá una pestaña abierta un rato largo y volvé: se renueva solo.
5. **Catálogo.** Creá un producto con foto, una categoría nueva desde el mismo formulario y un grupo de opciones obligatorio. Editalo y agregale un extra: los ids de las opciones se conservan (importante para los borradores de WhatsApp).
6. **Menú público.** Abrí `/toki-demo` en una ventana de incógnito. Tiene que cargar rápido y **no** mostrar stock ni códigos de barras.
7. **Checkout.** Armá un pedido. Probá un cupón inexistente (avisa), uno válido (muestra el descuento), y confirmá.
8. **Tiempo real.** Con el tablero abierto en otra ventana, confirmá ese pedido: tiene que aparecer solo, con sonido. Movelo de estado y mirá el historial.
9. **POS.** Cargá una venta de mostrador con opciones y verificá el total.
10. **Comprobantes.** Si tenés uno cargado, abrí el pedido: la imagen se ve con URL firmada y se puede aprobar.
11. **Configuración.** Cambiá logo, portada, horarios, horarios especiales, medios de pago y fidelización. Guardá y recargá.
12. **Clientes y buscador.** Revisá la tabla de clientes (pedidos, gastado, última dirección) y el buscador del Topbar.
13. **Cerrar sesión** y volver a entrar.

### Lo que conviene mirar con atención

- **La consola del navegador**, en Network: cada pantalla tendría que hacer bastante menos requests que antes.
- **El menú público y el checkout**: son las pantallas que ven tus clientes.
- **El modo demo**: sin `VITE_API_URL`, el front sigue andando con datos de ejemplo, igual que antes sin las claves de Supabase.

---

## 5. Lo que queda afuera

- **`npm run build` completo**: corrélo vos (explicado arriba).
- **El DashboardPage sigue calculando sus métricas en el navegador** a partir de los pedidos de 30 días. `GET /dashboard/summary` ya devuelve todo calculado en SQL: cambiarlo es una mejora aparte, no la dejé mezclada con la migración para no reescribir la pantalla entera a ciegas.
- **Elegir entre varios negocios**: el front toma el primero. La API ya soporta `X-Business-Id`, falta el selector.
- **Canje de puntos de fidelización**: se acumulan, no se canjean (igual que en Supabase).
