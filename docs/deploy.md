# Deploy — del VPS vacío a la API andando

Guía de punta a punta: servidor recién creado → Dokploy → Toki en producción en `https://toki-api.koistudio.com.ar`. Se hace una vez; después cada deploy es un push a `main`.

**A mano vas a necesitar:** el IP del VPS y su password de root, acceso al DNS de `koistudio.com.ar` (Vercel), la cuenta de GitHub `koiwebstudio00-cmd`, las keys de Cloudflare R2, la API key de Resend y la de Zernio.

**Ubicación de las cosas:**

| Qué | Dónde |
| --- | --- |
| Front | `https://toki.koistudio.com.ar` (Vercel) |
| API | `https://toki-api.koistudio.com.ar` (este VPS) |
| Panel de Dokploy | `http://<IP>:3000` al principio, después un subdominio |
| Base de datos | Dentro del VPS, sin puerto público |

---

## 1. Preparar el VPS

Todo esto se corre desde tu Mac, en una terminal.

### 1.1 Primer login y actualización

```bash
ssh root@<IP-DEL-VPS>
```

Ya adentro:

```bash
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban
timedatectl set-timezone America/Argentina/Tucuman
```

### 1.2 Usuario propio (no trabajar como root)

```bash
adduser cacho              # te pide una password, poné una buena
usermod -aG sudo cacho
```

### 1.3 Llave SSH

**En tu Mac**, en otra terminal:

```bash
ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519 -C "cacho@koi"
ssh-copy-id cacho@<IP-DEL-VPS>
```

Probá que entra sin password **antes de seguir**:

```bash
ssh cacho@<IP-DEL-VPS>
```

Si eso funciona, cerrá la puerta de las passwords. Como root en el VPS:

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
```

> **No cierres esta sesión root todavía.** Abrí otra terminal y confirmá que `ssh cacho@<IP>` sigue entrando. Si te quedaste afuera, la consola web del proveedor es la única forma de volver.

### 1.4 Swap

El build de la imagen (`npm ci` + `tsc`) es lo más pesado que va a correr el servidor. Si el VPS tiene 4 GB o menos, sin swap el build puede morir con "Killed" y no vas a entender por qué.

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h        # tiene que mostrar 2Gi en Swap
```

### 1.5 Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp      # panel de Dokploy; lo cerramos en el paso 9
ufw --force enable
ufw status
```

**Ojo con una trampa clásica:** UFW **no** filtra los puertos que publica Docker — Docker escribe sus propias reglas de iptables por debajo. O sea que un `ufw deny 3000` no alcanza para esconder el panel. En el paso 9 se cierra de la forma que sí funciona.

---

## 2. Instalar Dokploy

Como **root**:

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

Instala Docker si falta, inicializa Swarm y levanta el panel. Tarda unos minutos.

Cuando termina, abrí `http://<IP-DEL-VPS>:3000` en el navegador y **creá la cuenta de administrador en ese momento**: el primer registro es el dueño, y conviene que seas vos y no alguien que escaneó el puerto.

> Si el instalador se queja de que un puerto está ocupado, es que el VPS no estaba tan vacío. `ss -tlnp | grep -E ':(80|443|3000)'` te dice quién lo tiene.

---

## 3. DNS en Vercel

En el panel de Vercel, en el dominio `koistudio.com.ar`, agregá **un registro A**:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `toki-api` | `<IP-DEL-VPS>` | 60 |

Nada de proxy ni CNAME: tiene que resolver al IP directo o Let's Encrypt no va a poder emitir el certificado.

Esperá a que propague y verificá desde tu Mac:

```bash
dig +short toki-api.koistudio.com.ar
# tiene que imprimir el IP del VPS
```

**No sigas al paso 8 hasta que esto responda bien.** Si pedís el certificado antes de tiempo, Let's Encrypt te cuenta el intento fallido contra su límite.

---

## 4. Generar los secretos

En tu Mac. Guardalos en tu gestor de contraseñas a medida que salen, porque algunos no se pueden recuperar.

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD  (rol toki_owner, dueño de la base)
openssl rand -hex 32   # password de toki_app (rol de conexión de la API)
openssl rand -hex 32   # JWT_SECRET
```

La key del agente de WhatsApp es distinta: **la key en claro va a n8n y al servidor solo va su hash.**

```bash
KEY=$(openssl rand -hex 32)
echo "$KEY"                                     # ← esto va a n8n
printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1  # ← esto va a AGENT_API_KEY_SHA256
```

**Siempre hex, nunca base64.** Una `/` en una password rompe la connection string de Postgres y el error que te da no dice eso.

---

## 5. Cloudflare R2

Ya lo tenés hecho. Solo confirmá dos cosas:

- Los tres buckets existen: `toki-public`, `toki-private`, `toki-backups`.
- En `toki-public` → **Settings → CORS**, el origen es el del front:

```json
[
  {
    "AllowedOrigins": ["https://toki.koistudio.com.ar"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Sin esa política, el navegador no puede subir imágenes de productos aunque la API firme bien la URL.

`R2_ACCOUNT_ID` es el id de 32 caracteres hex, **no** el endpoint. Si pegás el endpoint completo la app se queda con el id igual; cualquier otra cosa y se niega a arrancar diciendo por qué.

## 6. Resend

También hecho. Verificá que `koistudio.com.ar` (o el subdominio que hayas agregado) figure **Verified**, con SPF, DKIM y DMARC cargados. Sin eso los mails de verificación caen en spam y nadie termina de registrarse.

La API key de Resend va como `SMTP_PASS`. El `SMTP_USER` es literalmente `resend`.

---

## 7. Subir el código a GitHub

El repo remoto ya existe: `koiwebstudio00-cmd/toki-backend`. Lo que falta es mandar todo lo que venimos commiteando local.

En tu Mac, en `~/koi/toki-platform/toki-api`:

```bash
# 1. Revisá la última fase antes de mezclar
git log --oneline fase8 -5

# 2. Consolidar en dev
git checkout dev
git merge --no-ff fase8 -m "merge fases 3 a 8: backend propio completo"

# 3. Correr todo una vez más sobre dev
npm run lint && npm run typecheck && npm run build && npm test

# 4. Y a main, que es lo que despliega Dokploy
git checkout main
git merge --no-ff dev -m "backend propio: reemplazo de Supabase"

# 5. Push
git push origin main
git push origin dev
```

Después hacé lo mismo con el workflow del agente, que vive en su propio repo:

```bash
cd ../toki-agents
git checkout main && git merge --no-ff fase8 -m "agente v2 contra la API propia"
git push origin main
```

> **Chequeo rápido:** entrá al repo en GitHub y confirmá que **no** aparece ningún archivo `.env` (solo `.env.production.example`, que es placeholders). Si se coló uno con secretos de verdad, rotá todo antes de seguir.

---

## 8. Crear el stack en Dokploy

En el panel:

1. **Create Project** → nombre `toki`.
2. Dentro del proyecto, **Create Service → Compose**.
3. **Provider: GitHub.** La primera vez te va a pedir conectar la cuenta: seguí el flujo de autorización de GitHub y dale acceso al repo `toki-backend` (podés limitarlo a ese repo solo).
4. Repositorio `koiwebstudio00-cmd/toki-backend`, branch `main`, **Compose Path** `docker-compose.yml`.
5. En la pestaña **Environment**, pegá esto reemplazando los `<...>`:

```bash
NODE_ENV=production
PORT=3000
APP_VERSION=1.0.0

POSTGRES_PASSWORD=<hex de toki_owner>

DATABASE_URL=postgresql://toki_app:<hex de toki_app>@toki-db:5432/toki
DATABASE_URL_MIGRATE=postgresql://toki_owner:<hex de toki_owner>@toki-db:5432/toki
DATABASE_URL_LISTEN=postgresql://toki_app:<hex de toki_app>@toki-db:5432/toki
DB_POOL_MAX=10

CORS_ORIGIN=https://toki.koistudio.com.ar
FRONT_URL=https://toki.koistudio.com.ar

JWT_SECRET=<hex>
AGENT_API_KEY_SHA256=<el sha256, no la key>

SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=<API key de Resend>
EMAIL_FROM=Toki <no-reply@koistudio.com.ar>

R2_ACCOUNT_ID=<32 hex>
R2_ACCESS_KEY_ID=<access key>
R2_SECRET_ACCESS_KEY=<secret>
R2_BUCKET_PUBLIC=toki-public
R2_BUCKET_PRIVATE=toki-private
R2_PUBLIC_URL=https://<hash>.r2.dev

ZERNIO_API_KEY=<api key de Zernio>
ZERNIO_BASE_URL=https://zernio.com/api/v1
```

Tres cosas que se equivocan siempre:

- **El host de la base es `toki-db`**, el nombre del servicio en el compose, no `localhost` ni el IP.
- **`CORS_ORIGIN` sin barra final.** Con `https://toki.koistudio.com.ar/` el front recibe error de CORS y el mensaje no ayuda.
- **`AGENT_API_KEY_SHA256` es el hash**, no la key. Si pegás la key, n8n va a recibir 401 en todos los nodos.

6. **Deploy.**

### Qué va a pasar en este primer deploy

La base arranca bien. **La API va a fallar y reiniciarse en loop**, y está bien: el rol `toki_app` todavía no existe. En los logs vas a ver `password authentication failed for user "toki_app"` o `role "toki_app" does not exist`.

Eso se arregla en el paso siguiente.

---

## 9. Bootstrap de la base (una sola vez)

Entrá por SSH al VPS y buscá el contenedor de Postgres:

```bash
docker ps --format '{{.ID}}  {{.Names}}' | grep toki-db
```

Abrí `psql` como dueño:

```bash
docker exec -it <ID-del-contenedor> psql -U toki_owner -d toki
```

Y pegá esto, **reemplazando `<hex de toki_app>` por la password que generaste en el paso 4**:

```sql
create role toki_app login noinherit password '<hex de toki_app>';
grant connect on database toki to toki_app;
grant anon, authenticated, service_role to toki_app;
```

Verificá. Esperado: `f`, `f`, `f`, y después tres filas:

```sql
select rolname, rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = 'toki_app';

select r.rolname from pg_auth_members m
  join pg_roles r on r.oid = m.roleid
  join pg_roles g on g.oid = m.member
 where g.rolname = 'toki_app' order by 1;
```

Salí con `\q`.

> **Por qué el `grant` va acá y no solo en la migración.** La migración `0002` otorga esos tres roles, pero solo si `toki_app` ya existe; si no, deja un warning y **se marca como aplicada**, así que nunca se vuelve a correr. Como en este orden la API migró antes de que el rol existiera, este `grant` manual es lo único que lo arregla. Si te lo saltás, la API arranca pero **todo responde 403 o "permission denied"**, que es un síntoma mucho más confuso que un error de arranque. El archivo `scripts/bootstrap-prod.sql` tiene esto mismo en versión idempotente.
>
> `NOINHERIT` es el corazón del modelo de seguridad: la API se conecta con un rol que **no puede leer nada por sí mismo**. Cada consulta adopta `anon`, `authenticated` o `service_role` dentro de una transacción, y RLS decide qué ve.

Volvé a Dokploy y dale **Redeploy**. Ahora la API tiene que quedar arriba.

---

## 10. Dominio y HTTPS

En el servicio `toki-api`, pestaña **Domains → Add Domain**:

- **Host:** `toki-api.koistudio.com.ar`
- **Service:** `toki-api` (no `toki-db`)
- **Port:** `3000`
- **HTTPS:** activado, **Let's Encrypt**

Guardá y esperá un minuto a que emita el certificado.

```bash
curl https://toki-api.koistudio.com.ar/v1/health
# {"ok":true,"db":"up","version":"1.0.0"}
```

Si dice `db: "down"`, la API está viva pero no llega a la base: revisá `DATABASE_URL` y el bootstrap del paso 9.

### Cerrar el panel de Dokploy

Ahora que la API anda, el puerto 3000 abierto al mundo es un panel de administración expuesto.

En **Settings → Server**, asignale un dominio al propio Dokploy (por ejemplo `dokploy.koistudio.com.ar`, con su registro A al mismo IP) y activá HTTPS. Después cerrá el puerto:

```bash
ufw delete allow 3000/tcp
# UFW no alcanza para lo que publica Docker: esta es la regla que sí filtra
iptables -I DOCKER-USER -p tcp --dport 3000 ! -s 127.0.0.1 -j DROP
apt install -y iptables-persistent   # para que sobreviva al reboot
netfilter-persistent save
```

Comprobá desde tu Mac que `http://<IP>:3000` ya no responde y que el dominio nuevo sí.

---

## 11. Verificación

```bash
sh scripts/smoke.sh https://toki-api.koistudio.com.ar
```

Comprueba que la base responde, que las rutas privadas piden sesión, que las del agente piden API key y que no se filtra `x-powered-by`.

Después, a mano, lo que el smoke no puede probar:

1. **Registrar una cuenta de prueba** y confirmar que el mail de verificación llega **a la bandeja de entrada, no a spam**.
2. **Crear un negocio**, subir una imagen de producto (esto prueba R2 + CORS de una).
3. **Abrir el menú público** y hacer un pedido con el tablero abierto en otra pestaña: tiene que aparecer solo, sin refrescar (eso prueba el tiempo real).

---

## 12. Backups

En Dokploy, **Scheduled Task** diaria (03:00) que corra dentro del contenedor de la API:

```bash
sh scripts/backup-to-r2.sh
```

Necesita `postgresql-client` y `aws-cli` en la imagen, o correrlo desde un contenedor que los tenga con las mismas variables. El script hace `pg_dump` comprimido, **se niega a subir un dump de menos de 5 KB** (si el dump falló, no queremos que la rotación borre los buenos), sube a `toki-backups/toki/AAAA/MM/` y borra los de más de 30 días.

### Probar el restore

**Hacelo antes de migrar los datos reales.** Si nunca restauraste un backup, no tenés backups.

```bash
sh scripts/restore-from-r2.sh --list

createdb toki_restore
sh scripts/restore-from-r2.sh toki/2026/09/toki-20260921-030000.dump.gz \
  postgresql://toki_owner:...@localhost:5432/toki_restore
```

Al final imprime cuántos negocios, pedidos, productos y usuarios quedaron. El script **no restaura sobre producción a propósito**: exige que la base destino se llame `*restore*` o `*staging*`.

---

## 13. Conectar el resto

- **Front:** en Vercel, variable `VITE_API_URL=https://toki-api.koistudio.com.ar` y redeploy.
- **n8n:** importar `toki-agents/n8n/toki-agent-v2.json`, reemplazar `https://api.tudominio.com` por `https://toki-api.koistudio.com.ar` y `PEGAR_TOKI_AGENT_API_KEY_AQUI` por la key en claro del paso 4. Detalle en [`fases/fase8.md`](fases/fase8.md).
- **Datos:** migrar desde Supabase siguiendo [`fases/fase7.md`](fases/fase7.md).

## 14. Deploys siguientes

Con **Auto Deploy** activado, cada push a `main` construye y reemplaza el contenedor. El entrypoint aplica las migraciones nuevas antes de levantar.

- Si una migración falla, el contenedor no arranca y **queda el anterior sirviendo**. Se ve en los logs de Dokploy.
- El cierre es limpio: la API recibe `SIGTERM`, cierra el stream de tiempo real y las conexiones.
- Migraciones destructivas (borrar una columna): dos deploys. Primero el código que deja de usarla, después la migración que la borra.

---

## 15. Checklist antes de mandar tráfico real

- [ ] `ssh cacho@<IP>` entra con llave y `PasswordAuthentication no`
- [ ] Swap activo (`free -h`)
- [ ] Panel de Dokploy detrás de dominio y puerto 3000 cerrado
- [ ] `toki_app` con `rolsuper = f`, `rolbypassrls = f`, `rolinherit = f` **y los tres roles de contexto**
- [ ] La base sin puerto publicado (`docker ps` no muestra `5432->`)
- [ ] `CORS_ORIGIN` exacto, sin barra final
- [ ] Dominio de Resend verificado (SPF, DKIM, DMARC)
- [ ] CORS del bucket público configurado
- [ ] Bucket privado **sin** acceso público
- [ ] `sh scripts/smoke.sh https://toki-api.koistudio.com.ar` en verde
- [ ] Un backup hecho **y restaurado** en una base de prueba
- [ ] La key del agente guardada en n8n (en el servidor solo vive el hash)
- [ ] Registro de una cuenta de prueba de punta a punta, con el mail en la bandeja de entrada

---

## 16. Si algo falla

| Síntoma | Causa más probable | Qué hacer |
| --- | --- | --- |
| `role "toki_app" does not exist` | Falta el bootstrap | Paso 9 y redeploy |
| `password authentication failed for user "toki_app"` | La password del `create role` no es la de `DATABASE_URL` | `alter role toki_app password '<hex>'` |
| Todo responde 403 o `permission denied for table ...` | `toki_app` existe pero sin los roles de contexto (la `0002` corrió antes) | `grant anon, authenticated, service_role to toki_app;` |
| `password authentication failed` genérico | La password tiene `/` o `@` sin escapar | Regenerar con `openssl rand -hex 32` |
| El health dice `db: "down"` | La API arrancó antes que la base | `depends_on: service_healthy` ya lo cubre; si persiste, revisar el host en `DATABASE_URL` |
| El build muere con `Killed` | Se quedó sin RAM | Swap (paso 1.4) |
| El certificado no se emite | El DNS todavía no resuelve al IP | `dig +short toki-api.koistudio.com.ar` y esperar |
| El front recibe error de CORS | `CORS_ORIGIN` mal escrito o con barra final | Corregir y redeploy |
| Los mails no llegan | Dominio sin verificar en Resend | Completar SPF, DKIM y DMARC |
| Las imágenes no suben desde el navegador | Falta la política de CORS en el bucket público | Paso 5 |
| La subida falla con un host raro y repetido | `R2_ACCOUNT_ID` mal cargado | Poné el id de 32 hex; la app lo normaliza y valida al arrancar |
| El tiempo real no manda eventos | `DATABASE_URL_LISTEN` mal, o el pool sin conexiones libres | Dejar una connection string aparte para LISTEN |
