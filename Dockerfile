# Imagen de producción para Dokploy. Base: Dockerfile de back-lamelas.
#
# Diferencias con Lamelas:
# - Prisma con engineType "client": en runtime no hay query engine nativo.
#   El CLI (prisma migrate deploy) sí baja su schema engine en el build.
# - bcrypt 6 trae binarios precompilados: no hace falta toolchain de C++.

# ── Base común ───────────────────────────────────────────────────────────────
FROM node:22-slim AS base
WORKDIR /app
# openssl: lo usa el schema engine de `prisma migrate deploy` en el entrypoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ── Build ────────────────────────────────────────────────────────────────────
FROM base AS builder
# Explícito: con NODE_ENV=production `npm ci` omitiría tsc y prisma.
ENV NODE_ENV=development

COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall corre `prisma generate` (necesita el schema ya copiado).
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 # Baja el schema engine ahora para que el entrypoint no dependa de red.
 && npx prisma --version

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

# node_modules entero del builder: incluye el CLI de Prisma y su schema engine,
# que el entrypoint usa para migrar.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
