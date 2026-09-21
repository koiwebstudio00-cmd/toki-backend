# Fase 7 — Migración de datos y corte

**Rama:** `fase7` (sale de `fase6`) · **Fecha:** 2026-09-19 · **Tests:** 229 en verde

La última fase: mover los datos reales de tus pilotos de Supabase al VPS y apagar Supabase. Los scripts están escritos y **probados contra una base que simula Supabase**; la corrida real es tuya, con tus credenciales.

---

## 1. Qué se construyó

| Archivo | Para qué |
| --- | --- |
| `scripts/compare-schema.ts` | Compara el schema real de Supabase contra la réplica del VPS. **Primer paso, antes de mover un dato.** |
| `scripts/migrate-supabase.ts` | La migración: usuarios, datos, archivos, URLs y verificación |
| `scripts/lib/migration.ts` | Orden de tablas, utilidades compartidas |

```bash
npm run compare:schema
npm run migrate:supabase -- --dry-run
npm run migrate:supabase
```

### `compare:schema` — el paso que no se saltea

El hallazgo **H1** de la fase 0 fue que el repo de migraciones de Supabase tenía deriva con lo que estaba aplicado de verdad (un archivo editado después de aplicarse). La réplica se construyó desde ese repo, así que **antes de migrar hay que confirmar que las dos bases son iguales**.

El script compara, entre las dos bases: columnas y tipos, defaults, constraints, índices, policies RLS, RLS habilitado por tabla, firmas de funciones, cuerpo de funciones (por hash), triggers y enums. Lista lo que está de un lado y no del otro.

Si aparece algo, se resuelve con una migración nueva en `prisma/migrations/`. No se toca la base a mano.

### `migrate:supabase` — cinco pasos

| Paso | Qué hace |
| --- | --- |
| `users` | `auth.users` de Supabase → nuestra `auth.users`. **Las contraseñas siguen sirviendo**: Supabase guarda bcrypt `$2a$`, que es el mismo formato que lee nuestra auth |
| `data` | Las 28 tablas de `public`, en orden de dependencias, conservando los ids |
| `storage` | `product-images` y `business-assets` → `toki-public`; `payment-proofs` → `toki-private`. Las keys no cambian |
| `urls` | Reescribe `logo_url`, `cover_url`, `categories.image_url` y `products.image_url` del host de Supabase al de R2 |
| `verify` | Conteo por tabla, usuarios y **suma de `orders.total`** |

Detalles que importan:

- **No transforma ids.** Las claves foráneas, los links de seguimiento de pedidos (`TK-XXXXXX`) y los `option_value_ids` de los borradores de WhatsApp siguen válidos.
- **Corta si la base destino ya tiene datos**, salvo `--force`. Y tiene `--dry-run`, que no escribe nada.
- **Usuarios sin contraseña** (los que entraron con OAuth o magic link) reciben un hash imposible de acertar y un aviso: entran con "Olvidé mi contraseña", que de paso les verifica el email.
- **`--only=`** para correr un paso suelto (`--only=storage` si se cortó a mitad).

## 2. El bug que apareció al probarlo

Armé una base que simula Supabase (con `auth.users` en su forma original y `storage.objects`), la cargué con un negocio, un pedido y dos usuarios, y corrí la migración contra una base limpia.

La verificación falló: **`profiles: 1 → 2`**.

El motivo: copiar los usuarios dispara el trigger `handle_new_user`, que crea un perfil por cada usuario insertado. Después, el perfil real de Supabase chocaba con ese y se descartaba. Resultado: perfiles de más, y los datos reales (teléfono, avatar) perdidos.

La corrección es apagar los triggers durante **toda** la copia, no solo durante los datos:

```sql
set session_replication_role = replica;
```

Sin esto, además, `set_updated_at` habría pisado todas las fechas `updated_at` con la del día de la migración.

Después del arreglo, la corrida completa da:

```
✓ auth.users: 2 → 2       ✓ businesses: 1 → 1     ✓ profiles: 1 → 1
✓ orders: 1 → 1           ✓ order_items: 1 → 1    ✓ payments: 1 → 1
✓ suma de orders.total: 12000.00 → 12000.00
```

Y verificado a mano en la base destino:

- las URLs quedaron apuntando a R2;
- el hash `$2a$` del usuario con contraseña se conservó intacto;
- el usuario sin contraseña quedó con el hash imposible;
- `created_at` y `updated_at` del pedido siguen siendo los originales.

---

## 3. La ventana de migración, paso a paso

Con pocos negocios piloto alcanzan 15 a 30 minutos, en un horario sin pedidos (un martes a la mañana, no un viernes a la noche).

### Días antes

1. **Infra lista** (fase 5): API en producción, health OK, **un backup restaurado** en una base de prueba.
2. **Comparar schemas:**
   ```bash
   export SUPABASE_URL_DB="postgresql://postgres.<ref>:<pass>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   export TARGET_URL_DB="postgresql://toki_owner:<pass>@localhost:5432/toki"   # por túnel SSH
   npm run compare:schema
   ```
   Usá el **session pooler** (puerto 5432): la conexión directa de Supabase es solo IPv6.
3. **Ensayo completo** contra una base de staging en el VPS, con los datos reales. Es el ensayo el que te dice cuánto tarda de verdad.
4. **Buckets de R2** creados, con CORS y dominio público (fase 5).

### El día

```bash
# 0. Túnel a la base del VPS (la base no expone puerto a internet)
ssh -L 5432:localhost:5432 usuario@tu-vps

# 1. Freeze: el front en mantenimiento y el workflow de n8n pausado.

# 2. Exportar las variables
export SUPABASE_URL_DB="postgresql://..."      # session pooler
export TARGET_URL_DB="postgresql://toki_owner:...@localhost:5432/toki"
export SUPABASE_URL="https://<proyecto>.supabase.co"
export SUPABASE_SERVICE_KEY="<service_role key>"
export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
export R2_BUCKET_PUBLIC=toki-public R2_BUCKET_PRIVATE=toki-private
export R2_PUBLIC_URL=https://cdn.tudominio.com

# 3. Primero sin escribir nada
npm run migrate:supabase -- --dry-run

# 4. La migración
npm run migrate:supabase
```

El script termina diciendo si todo cuadra. **Si dice que hay diferencias, no sigas.**

### Smoke test antes de abrir la puerta

```bash
sh scripts/smoke.sh https://api.tudominio.com toki-demo
```

Y a mano, con datos reales:

1. **Login de un usuario real** con su contraseña de siempre (esto prueba que los hashes viajaron bien).
2. **Menú público de cada negocio**: que carguen las imágenes (vienen de R2 ahora).
3. **Seguimiento de un pedido viejo** por su código.
4. **Un pedido nuevo** de punta a punta, con el tablero abierto: tiene que aparecer solo.
5. **Un pedido por WhatsApp** con el agente ya recableado.
6. **Un cambio de estado** y su historial.

### El corte

1. Front apuntando a la API (`VITE_API_URL`) y desplegado.
2. n8n con las URLs nuevas y la `X-Api-Key` (tabla de equivalencias en [`fase4.md`](fase4.md)).
3. Sacar el cartel de mantenimiento.

### Rollback

**Supabase queda intacto y en solo lectura una semana.** Si algo sale mal en las primeras horas, volver es apuntar el front y n8n a Supabase de nuevo. Pasada esa semana, sin sobresaltos, se puede dar de baja.

Pensalo así: mientras no llegue un pedido nuevo al VPS, volver atrás es gratis. Después del primer pedido, volver significa perder ese pedido. Por eso el smoke test va **antes** de sacar el mantenimiento.

---

## 4. Checklist de la ventana

- [ ] Backup del VPS hecho y restaurado en una base de prueba
- [ ] `npm run compare:schema` sin diferencias
- [ ] Ensayo en staging con los datos reales, cronometrado
- [ ] Front en mantenimiento y n8n pausado
- [ ] `npm run migrate:supabase -- --dry-run` sin sorpresas
- [ ] `npm run migrate:supabase` termina con "Todo cuadra"
- [ ] `sh scripts/smoke.sh` en verde
- [ ] Login de un usuario real con su contraseña de siempre
- [ ] Menú público de cada negocio con sus imágenes
- [ ] Un pedido web de punta a punta, con tiempo real
- [ ] Un pedido por WhatsApp
- [ ] Front y n8n apuntando a la API
- [ ] Supabase en solo lectura (no borrarlo todavía)

---

## 5. Después del corte

Una semana después, si todo anduvo:

- Dar de baja el proyecto de Supabase.
- Borrar del front las variables `VITE_SUPABASE_*` que hayan quedado.
- Sacar del repo `supabase/functions/` (las Edge Functions ya no se usan).
- Limpiar las columnas heredadas de Meta en `whatsapp_integrations` (hallazgo H3), con una migración.
