# Levantar Toki en tu compu

Guía para arrancar el proyecto completo en una máquina nueva: la API con su base de datos local y el front. Tarda unos 20 minutos.

**Necesitás:** Node 22 o superior, PostgreSQL 17, Git y acceso a los repos privados de `koiwebstudio00-cmd` en GitHub. No hace falta Docker ni Supabase. La carpeta es `toki-backend`; el package y servicio mantienen el nombre `toki-api`.

| Repo en GitHub | Carpeta local | Qué es |
| --- | --- | --- |
| `toki-backend` | `toki-backend` | API (Express + Prisma + PostgreSQL) |
| `toki` | `toki` | Front (React + Vite): panel del negocio y menú público |
| `toki-agents` | `toki-agents` | Workflows de n8n, prompts y pruebas del agente de WhatsApp |

---

## 1. Instalar PostgreSQL

### macOS (Homebrew)

```bash
brew install postgresql@17
brew services start postgresql@17
# Dejar los comandos de Postgres en el PATH (zsh):
echo 'export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

En macOS, Homebrew crea un usuario de Postgres con **tu nombre de usuario del sistema** y sin contraseña. Ese es el "usuario dueño" que usan las migraciones.

### Ubuntu / Debian

```bash
sudo apt install -y postgresql-17
sudo -u postgres createuser --superuser $USER   # tu usuario del sistema como dueño
```

### Windows

Instalá PostgreSQL 17 desde [postgresql.org/download/windows](https://www.postgresql.org/download/windows/). Durante la instalación elegís la contraseña del usuario `postgres`; anotala, porque va en el `.env`. Después corré los comandos desde **PowerShell** o **Git Bash**.

### Verificar

```bash
psql --version     # PostgreSQL 17.x
whoami             # tu usuario: lo vas a usar en el .env
```

## 2. Clonar los repos

Los tres van dentro de una misma carpeta:

```bash
mkdir toki-platform && cd toki-platform
git clone https://github.com/koiwebstudio00-cmd/toki-backend.git
git clone https://github.com/koiwebstudio00-cmd/toki.git
git clone https://github.com/koiwebstudio00-cmd/toki-agents.git
```

**Rama de trabajo: `dev`**. Si un repo no publica `origin/dev`, crear la rama local desde `main` con `git switch -c dev`.

```bash
for d in toki-backend toki toki-agents; do (cd "$d" && git switch dev); done
```

Para solo levantar la API y el front, `toki-agents` no hace falta.

## 3. Crear las dos bases

Una para desarrollo y otra para los tests (los tests **borran y recrean** la suya en cada preparación).

```bash
createdb toki
createdb toki_test
```

En Windows, si `createdb` pide usuario: `createdb -U postgres toki`.

## 4. Configurar la API

```bash
cd toki-backend
npm install
cp .env.example .env
```

`npm install` corre `prisma generate` solo: crea el cliente de base de datos tipado a partir de `prisma/schema.prisma`.

Abrí el `.env` y dejá estas dos líneas con **tu usuario** (reemplazá `dev0`):

```env
DATABASE_URL_MIGRATE=postgresql://dev0@localhost:5432/toki
DATABASE_URL_TEST=postgresql://dev0@localhost:5432/toki_test
```

En **Windows** (o si tu Postgres pide contraseña), usá el usuario `postgres`:

```env
DATABASE_URL_MIGRATE=postgresql://postgres:TU_PASSWORD@localhost:5432/toki
DATABASE_URL_TEST=postgresql://postgres:TU_PASSWORD@localhost:5432/toki_test
```

**`DATABASE_URL` no se toca.** Son dos usuarios distintos a propósito:

- **`DATABASE_URL_MIGRATE`** es el dueño de la base y solo se usa para aplicar migraciones.
- **`DATABASE_URL`** es `toki_app`, el usuario con el que corre la API. No tiene permisos propios: cada consulta adopta un rol (`anon`, `authenticated` o `service_role`) y las reglas de acceso de Postgres deciden qué ve. Es lo mismo que pasa en producción, así que los errores de permisos aparecen en tu compu y no después.

`CORS_ORIGIN` y `FRONT_URL` ya vienen apuntando al front local (`http://localhost:5173`). El resto de las variables (Resend, R2, Zernio) podés dejarlas vacías: los emails se imprimen en la consola y las subidas de imágenes devuelven URLs de mentira.

Los `.env` no viajan con Git. Si necesitás las credenciales reales de otra máquina, copiá el archivo a mano.

## 5. Migrar y cargar datos de prueba

```bash
npm run db:migrate:deploy   # crea el usuario toki_app y aplica todas las migraciones
npm run seed                # 2 negocios de ejemplo
```

El seed crea dos cuentas, las dos con la contraseña `toki12345`:

- `owner@burger.test` → Toki Demo Burger (`toki-demo`)
- `owner@pizza.test` → Pizzería Demo (`pizzeria-demo`)

### Poblar escenarios completos

El seed básico crea usuarios y catálogo mínimo; no crea pedidos. Desde `toki`:

```bash
npm run seed:catalog   # 18 productos: unidad, peso y agregados
npm run seed:debug     # 20 productos, 6 clientes, 14 pedidos y 6 conversaciones
```

Los 14 pedidos del lote de debug quedan fechados hoy en cada ejecución, incluidos los ya existentes; no se repiten ventas ni descuentos de stock. Solo se actualizan fechas de ese lote. Ver [seed debug](../../toki/docs/SEED-DEBUG.md) y [catálogo](../../toki/docs/CATALOG-SEED.md). Los tres seeds requieren una base local y rechazan producción.

## 6. Levantar la API

```bash
npm run dev                 # http://localhost:3000
```

Probala:

```bash
curl localhost:3000/v1/health
# {"ok":true,"db":"up","version":"dev"}

curl -X POST localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@burger.test","password":"toki12345"}'
```

La respuesta trae `accessToken`. Con eso ya podés pegarle al resto:

```bash
TOKEN=<pegá el accessToken>
curl localhost:3000/v1/business -H "authorization: Bearer $TOKEN"
curl localhost:3000/v1/products -H "authorization: Bearer $TOKEN"
```

## 7. Levantar el front

En otra terminal, con la API corriendo:

```bash
cd toki-platform/toki
npm install
cp .env.example .env
```

En ese `.env` dejá:

```env
VITE_API_URL=http://localhost:3000
```

**Sin `VITE_API_URL` el front arranca en modo demo**, con datos falsos y sin hablar con la API. `VITE_APP_URL` define la URL pública del frontend; los secretos van exclusivamente en el backend.

```bash
npm run dev                 # http://localhost:5173
```

Para entrar:

| Qué | URL | Con qué |
| --- | --- | --- |
| Panel del negocio | `http://localhost:5173/login` | `owner@burger.test` / `toki12345` |
| Menú público | `http://localhost:5173/toki-demo` | — |
| Menú público del segundo negocio | `http://localhost:5173/pizzeria-demo` | — |

Antes de dar por terminada una tarea en el front:

```bash
npm run lint && npm run build
```

## 8. Correr los tests de la API

```bash
cd toki-platform/toki-backend
npm run test:prepare   # recrea toki_test desde cero
npm test
```

`test:prepare` se corre una vez, y de nuevo cada vez que aparece una migración nueva.

La conexión de pruebas usa el rol exclusivo `toki_test_app` con `NOINHERIT` y los mismos roles de contexto que la API. `DATABASE_URL_TEST` sigue usando el dueño para preparar y limpiar datos. `DATABASE_TEST_APP_PASSWORD` (predeterminado: `toki_app_test`) se comparte entre preparación y suite; solo se usa para crear el rol si no existe. Si ya existe, se verifica la conexión antes de borrar la base y nunca se cambia su contraseña. No se modifica la contraseña de `toki_app`.

La preparación y la suite rechazan producción, nombres inválidos o sin sufijo `_test`, y una base con el mismo nombre que `DATABASE_URL`, `DATABASE_URL_MIGRATE` o `DATABASE_URL_LISTEN`, incluso con otro alias de host. La suite apunta también su conexión de tiempo real a la base de pruebas. Sin `DATABASE_URL_TEST`, ambas conexiones se reemplazan por un destino inalcanzable y nunca conservan las de desarrollo. Se rechazan parámetros de URL que sustituyan usuario, contraseña, destino o configuración de sesión; opciones TLS como `sslmode` se conservan. `test:prepare` borra solamente la base indicada en `DATABASE_URL_TEST`; no usarla para guardar datos que quieras conservar.

Antes de dar por terminada una tarea:

```bash
npm run lint && npm run typecheck && npm run build && npm test
```

Las pruebas del agente están en `toki-agents/tests` (ver su `README.md`).

---

## Qué no funciona en local

| Qué | Por qué | Cómo se prueba |
| --- | --- | --- |
| WhatsApp y el agente | Zernio necesita una URL pública para mandar el webhook, y `ZERNIO_API_KEY` | Con los tests de la API y las pruebas de `toki-agents` |
| Imágenes y comprobantes reales | Necesitan las credenciales de R2 en el `.env` | Sin credenciales, la subida devuelve una URL de mentira |
| Emails reales | Necesitan los datos de Resend en el `.env` | Sin ellos, el email se imprime en la consola de la API |

## Comandos del día a día

| Comando | Dónde | Para qué |
| --- | --- | --- |
| `npm run dev` | `toki-backend` | API con recarga automática |
| `npm run dev` | `toki` | Front con recarga automática |
| `npm test` / `npm run test:watch` | `toki-backend` | Tests |
| `npm run test:prepare` | `toki-backend` | Recrear la base de tests |
| `npm run db:migrate:deploy` | `toki-backend` | Aplicar migraciones nuevas a tu base local |
| `npm run db:migrate:create -- --name mi_cambio` | `toki-backend` | Crear una migración (**revisá el SQL antes de aplicarla**) |
| `npm run seed` | `toki-backend` | Recargar los negocios de ejemplo (no pisa lo que ya existe) |
| `npx prisma studio` | `toki-backend` | Ver la base en el navegador |

## Después de traer cambios

```bash
git pull
npm install                 # si cambió package.json
npm run db:migrate:deploy   # en toki-backend, si hay migraciones nuevas
npm run test:prepare        # en toki-backend, antes de volver a correr los tests
```

## Empezar de cero

```bash
dropdb toki && createdb toki
npm run db:migrate:deploy && npm run seed
```

---

## Si algo falla

| Error | Qué pasa | Solución |
| --- | --- | --- |
| `role "toki_app" does not exist` | Falta correr las migraciones | `npm run db:migrate:deploy` |
| `database "toki" does not exist` | Falta la base | `createdb toki` |
| `permission denied for table ...` | Una consulta salió sin adoptar un rol | Usá siempre `withDb(ctx, ...)`, nunca `getPrisma()` directo (ver `CLAUDE.md`) |
| `connection refused` en el puerto 5432 | Postgres apagado | macOS: `brew services start postgresql@17`. Linux: `sudo systemctl start postgresql` |
| `role "dev0" does not exist` | El usuario del `.env` no existe en esta máquina | Poné tu usuario (`whoami`) o `postgres` en `DATABASE_URL_MIGRATE` y `DATABASE_URL_TEST` |
| `Por seguridad la BD de test tiene que terminar en _test` | `DATABASE_URL_TEST` apunta a otra base | Apuntala a `toki_test` (esa base se borra y se recrea) |
| No se pudo conectar con toki_test_app | Contraseña existente distinta o falta acceso a la base postgres | Configurá DATABASE_TEST_APP_PASSWORD con la contraseña del rol de pruebas y verificá su acceso; no cambies toki_app |
| Falla bajar los binarios de Prisma | Sin internet o red bloqueada | `MIGRATE_WITH=sql npm run db:migrate:deploy` aplica el SQL directo |
| Los tests fallan después de traer cambios | Hay migraciones nuevas | `npm run test:prepare` |
| El front muestra datos que no son los tuyos | Está en modo demo | Falta `VITE_API_URL` en `toki/.env`; reiniciá `npm run dev` después de cambiarlo |
| El front no puede iniciar sesión o falla por CORS | La API no corre o el origen no coincide | Revisá que la API esté en el puerto 3000 y que `CORS_ORIGIN` sea la URL del front |

## Cómo está organizada la API

```text
src/
  app.ts, server.ts        arranque y montaje de rutas
  config.ts                variables de entorno validadas
  lib/                     base de datos, errores, tokens, emails, R2, Zernio
  middleware/              sesión, negocio actual, roles, API key, errores
  modules/<nombre>/        routes.ts → service.ts → repo.ts
prisma/
  schema.prisma            modelos (generados desde la base)
  migrations/              SQL: tablas, reglas de acceso, funciones
  seed.ts                  datos de ejemplo
test/                      tests de integración contra Postgres real
docs/                      descripción, arquitectura, API, base de datos, planes
```

**Antes de escribir código, leé `CLAUDE.md`** (reglas del proyecto) y, según la tarea, `docs/api.md` y `docs/arquitectura.md`.

## Revisión de aislamiento (28/10/2026)

Se ejecutó `test:prepare` contra la base de tests configurada, comparando antes y después los contadores de desarrollo y las contraseñas de los roles existentes: sin cambios. Los seeds básico, catálogo y debug se ejecutaron dos veces únicamente sobre esa base aislada. Se verificaron 14 pedidos con fecha actual, idempotencia de registros/stock/estados/importes y coherencia de reembolsos completados. La suite completa finalizó con 490 pruebas aprobadas, además de lint, typecheck y build.
