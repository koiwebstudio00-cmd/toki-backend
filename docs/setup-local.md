# Levantar Toki API en tu compu

Guía para arrancar el backend con la base de datos local. Tarda unos 15 minutos.

**Necesitás:** Node 22 o superior, PostgreSQL 17 y Git. No hace falta Docker ni Supabase.

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

## 2. Clonar e instalar

```bash
git clone https://github.com/koiwebstudio00-cmd/toki-backend.git toki-api
cd toki-api
npm install
```

`npm install` corre `prisma generate` solo: crea el cliente de base de datos tipado a partir de `prisma/schema.prisma`.

## 3. Crear las dos bases

Una para desarrollo y otra para los tests (los tests **borran y recrean** la suya en cada corrida).

```bash
createdb toki
createdb toki_test
```

En Windows, si `createdb` pide usuario: `createdb -U postgres toki`.

## 4. Configurar el `.env`

```bash
cp .env.example .env
```

Abrilo y dejá estas tres líneas con **tu usuario** (reemplazá `dev0`):

```env
DATABASE_URL=postgresql://toki_app:toki_app_dev@localhost:5432/toki
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

El resto de las variables (Resend, R2, Zernio) podés dejarlas vacías: los emails se imprimen en la consola y las subidas de imágenes devuelven URLs de mentira.

## 5. Migrar y cargar datos de prueba

```bash
npm run db:migrate:deploy   # crea el usuario toki_app y aplica las 3 migraciones
npm run seed                # 2 negocios de ejemplo
```

El seed crea dos cuentas, las dos con la contraseña `toki12345`:

- `owner@burger.test` → Toki Demo Burger (`toki-demo`)
- `owner@pizza.test` → Pizzería Demo (`pizzeria-demo`)

## 6. Levantar la API

```bash
npm run dev
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

## 7. Correr los tests

```bash
npm run test:prepare   # recrea toki_test desde cero
npm test
```

`test:prepare` se corre una vez, y de nuevo cada vez que aparece una migración nueva.

Antes de dar por terminada una tarea:

```bash
npm run lint && npm run typecheck && npm run build && npm test
```

---

## Comandos del día a día

| Comando | Para qué |
| --- | --- |
| `npm run dev` | API con recarga automática |
| `npm test` / `npm run test:watch` | Tests |
| `npm run test:prepare` | Recrear la base de tests |
| `npm run db:migrate:deploy` | Aplicar migraciones nuevas a tu base local |
| `npm run db:migrate:create -- --name mi_cambio` | Crear una migración (**revisá el SQL antes de aplicarla**) |
| `npm run seed` | Recargar los negocios de ejemplo (no pisa lo que ya existe) |
| `npx prisma studio` | Ver la base en el navegador |

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
| `role "dev0" does not exist` | El usuario del `.env` no existe | Poné tu usuario (`whoami`) o `postgres` en `DATABASE_URL_MIGRATE` y `DATABASE_URL_TEST` |
| `Por seguridad la BD de test tiene que terminar en _test` | `DATABASE_URL_TEST` apunta a otra base | Apuntala a `toki_test` (esa base se borra y se recrea) |
| Falla bajar los binarios de Prisma | Sin internet o red bloqueada | `MIGRATE_WITH=sql npm run db:migrate:deploy` aplica el SQL directo |
| Los tests fallan después de traer cambios | Hay migraciones nuevas | `npm run test:prepare` |

## Cómo está organizado

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
docs/                      descripción, arquitectura, API, base de datos, plan
```

**Antes de escribir código, leé `CLAUDE.md`** (13 reglas del proyecto) y, según la tarea, `docs/api.md` y `docs/arquitectura.md`.
