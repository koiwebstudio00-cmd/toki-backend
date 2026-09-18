# Deploy en el VPS con Dokploy

Guía para dejar la API andando en producción. Se hace una vez; después cada deploy es un push a `main`.

**Antes de empezar necesitás:** un VPS con Dokploy instalado, un dominio apuntando a ese VPS, una cuenta de Cloudflare (R2) y una de Resend.

---

## 1. Secretos (generalos primero y guardalos)

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD (toki_owner)
openssl rand -hex 32   # password de toki_app
openssl rand -hex 32   # JWT_SECRET

# API key del agente: la key va a n8n, el HASH va al servidor
KEY=$(openssl rand -hex 32)
printf %s "$KEY" | sha256sum | cut -d' ' -f1   # → AGENT_API_KEY_SHA256
echo "$KEY"                                     # → n8n (guardala, no se puede recuperar)
```

**Siempre hex, nunca base64:** una `/` en una password rompe la connection string.

## 2. Cloudflare R2

Tres buckets:

| Bucket | Para qué | Acceso |
| --- | --- | --- |
| `toki-public` | Imágenes de productos, logos, portadas | Público (dominio propio o r2.dev) |
| `toki-private` | Comprobantes de pago | Privado (se sirve con URLs firmadas) |
| `toki-backups` | Dumps de la base | Privado |

En `toki-public` → Settings → CORS, permití tu dominio con `PUT` y `GET` (el navegador sube la imagen directo al bucket con una URL prefirmada):

```json
[
  {
    "AllowedOrigins": ["https://app.tudominio.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Después creá un API token de R2 con permiso de lectura y escritura sobre los tres buckets. Te da `Access Key ID` y `Secret Access Key`.

## 3. Resend

Agregá tu dominio y cargá los registros **SPF, DKIM y DMARC** en el DNS. Esperá a que Resend lo marque verificado antes del primer deploy: sin eso, los mails de verificación de cuenta se van a spam y el registro de usuarios no funciona en la práctica.

La API key de Resend va como `SMTP_PASS` (el usuario es literalmente `resend`).

## 4. Base de datos

En Dokploy: **Create Service → Compose**, apuntando al repo y a `docker-compose.yml`.

Cargá primero las variables (pestaña Environment) con el contenido de [`.env.production.example`](../.env.production.example) completo, más `POSTGRES_PASSWORD`.

Levantá **solo la base** la primera vez (`docker compose up -d toki-db` desde la terminal de Dokploy, o desplegá y dejá que la API falle: todavía no existe `toki_app`).

### Bootstrap (una sola vez)

Entrá a la consola del contenedor de la base y creá el rol de la API:

```bash
psql -U toki_owner -d toki
```

```sql
create role toki_app login noinherit password '<password de toki_app>';
grant connect on database toki to toki_app;

-- Tiene que dar f, f, f
select rolname, rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = 'toki_app';
```

`NOINHERIT` es el corazón del modelo de seguridad: la API se conecta con un rol que **no puede leer nada por sí mismo**. Cada consulta adopta `anon`, `authenticated` o `service_role` dentro de una transacción, y las reglas de acceso de Postgres deciden qué ve. La migración `0002` le otorga esos tres roles a `toki_app` en el primer deploy.

## 5. Primer deploy de la API

Desplegá el stack completo. El entrypoint aplica todas las migraciones con el rol dueño y después levanta el servidor como `toki_app`.

En la pestaña **Domains**: `api.tudominio.com`, puerto `3000`, HTTPS con Let's Encrypt.

Verificá:

```bash
curl https://api.tudominio.com/v1/health
# {"ok":true,"db":"up","version":"1.0.0"}

sh scripts/smoke.sh https://api.tudominio.com
```

El smoke test comprueba que la base responde, que las rutas privadas piden sesión, que las del agente piden API key y que no se filtra `x-powered-by`.

## 6. Backups

En Dokploy, **Scheduled Task** diaria (por ejemplo 03:00) que corra dentro del contenedor de la API:

```bash
sh scripts/backup-to-r2.sh
```

Necesita `postgresql-client` y `aws-cli` en la imagen, o correrlo desde un contenedor que los tenga con las mismas variables de entorno. El script:

- hace `pg_dump` en formato custom, comprimido;
- **se niega a subir un dump de menos de 5 KB** (si el dump falló, no queremos que la rotación borre los buenos y deje uno vacío);
- sube a `toki-backups/toki/AAAA/MM/`;
- borra los de más de 30 días (`BACKUP_RETENTION_DAYS`).

### Probar el restore (hacelo antes de migrar datos reales)

```bash
sh scripts/restore-from-r2.sh --list

createdb toki_restore
sh scripts/restore-from-r2.sh toki/2026/09/toki-20260918-030000.dump.gz \
  postgresql://toki_owner:...@localhost:5432/toki_restore
```

Al final imprime cuántos negocios, pedidos, productos y usuarios quedaron. Si los números tienen sentido, el backup sirve. Si nunca restauraste un backup, no tenés backups.

El script **no restaura sobre producción a propósito**: exige que la base destino se llame `*restore*` o `*staging*`.

## 7. Deploys siguientes

Con **Auto Deploy** activado, cada push a `main` construye y reemplaza el contenedor. El entrypoint aplica las migraciones nuevas antes de levantar.

- Si una migración falla, el contenedor no arranca y queda el anterior sirviendo. Se ve en los logs de Dokploy.
- El cierre es limpio: la API recibe `SIGTERM`, cierra el stream de tiempo real y las conexiones a la base.
- Migraciones destructivas (borrar una columna): dos deploys. Primero el código que deja de usarla, después la migración que la borra.

## 8. Después del deploy

- **n8n:** recablear `toki-agent-v2.json` con `https://api.tudominio.com` y el header `X-Api-Key` (tabla de equivalencias en [`fases/fase4.md`](fases/fase4.md)).
- **Front:** apuntar el cliente HTTP a la API (fase 6).
- **Datos:** migrar desde Supabase (fase 7).

## 9. Checklist antes de mandar tráfico real

- [ ] `toki_app` con `rolsuper = f`, `rolbypassrls = f`, `rolinherit = f`
- [ ] La base sin puerto publicado (`docker ps` no muestra `5432->`)
- [ ] `CORS_ORIGIN` con la lista real, sin barra final
- [ ] Dominio de Resend verificado (SPF, DKIM, DMARC)
- [ ] CORS del bucket público configurado
- [ ] Bucket privado **sin** acceso público
- [ ] `sh scripts/smoke.sh https://api.tudominio.com` en verde
- [ ] Un backup hecho **y restaurado** en una base de prueba
- [ ] La key del agente guardada en n8n (en el servidor solo vive el hash)
- [ ] Registro de una cuenta de prueba de punta a punta: mail de verificación que llega a la bandeja de entrada, no a spam

## 10. Si algo falla

| Síntoma | Causa más probable | Qué hacer |
| --- | --- | --- |
| `role "toki_app" does not exist` | Falta el bootstrap del paso 4 | Correr el `create role` y redesplegar |
| `permission denied for table ...` | La migración `0002` no corrió, o el rol no tiene los roles de contexto | Ver logs del entrypoint; reaplicar `0002` |
| `password authentication failed` | La password tiene `/` o `@` sin escapar | Regenerar con `openssl rand -hex 32` |
| El health dice `db: "down"` | La API arrancó antes que la base | `depends_on: service_healthy` ya lo cubre; si persiste, revisar el host en `DATABASE_URL` |
| El front recibe error de CORS | `CORS_ORIGIN` mal escrito o con barra final | Corregir y redesplegar |
| Los mails no llegan | Dominio sin verificar en Resend | Completar SPF, DKIM y DMARC |
| El tiempo real no manda eventos | `DATABASE_URL_LISTEN` mal, o el pool sin conexiones libres | Dejar una connection string aparte para LISTEN |
