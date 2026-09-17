import "dotenv/config";
import { z } from "zod";

// Variables de entorno validadas al arrancar. Ver docs/arquitectura.md §11.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  APP_VERSION: z.string().default("dev"),

  // Conexión de la API: rol toki_app (NOINHERIT, sin privilegios propios).
  // Cada transacción adopta anon/authenticated/service_role con withDb.
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  // Conexión dedicada a LISTEN (tiempo real, F3). Vacía = DATABASE_URL.
  DATABASE_URL_LISTEN: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Orígenes del navegador autorizados, separados por coma.
  CORS_ORIGIN: z.string().default(""),
  // URL del front: links de los emails (verificación, reset).
  FRONT_URL: z.string().default("http://localhost:5173"),

  JWT_SECRET: z.string().default(""),
  // SHA-256 (hex) de la API key que usa n8n en X-Api-Key. La key en claro nunca
  // vive en el servidor: generar con `openssl rand -hex 32` y hashear.
  AGENT_API_KEY_SHA256: z.string().default(""),

  // Emails: Resend por SMTP (smtp.resend.com:465, user "resend", pass = API key).
  // Sin SMTP_HOST los emails se imprimen en consola (dev).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default("Toki <no-reply@localhost>"),

  // Cloudflare R2. Sin credenciales, presign/delete quedan en modo stub (dev/test).
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_PUBLIC: z.string().default("toki-public-dev"),
  R2_BUCKET_PRIVATE: z.string().default("toki-private-dev"),
  R2_PUBLIC_URL: z.string().optional(),

  // Zernio (WhatsApp). Una key para todo el team; nunca se expone al front.
  ZERNIO_API_KEY: z.string().optional(),
  ZERNIO_BASE_URL: z.string().default("https://zernio.com/api/v1")
});

export const config = envSchema.parse(process.env);

if (config.NODE_ENV === "production") {
  const missing: string[] = [];
  if (config.JWT_SECRET.length < 32) missing.push("JWT_SECRET (openssl rand -hex 32)");
  if (!config.CORS_ORIGIN) missing.push("CORS_ORIGIN");
  if (!/^[a-f0-9]{64}$/.test(config.AGENT_API_KEY_SHA256)) {
    missing.push("AGENT_API_KEY_SHA256 (sha256 hex de la key de n8n)");
  }
  if (missing.length > 0) {
    // Preferimos no arrancar antes que arrancar inseguro.
    throw new Error(`Configuración incompleta para producción: ${missing.join(", ")}.`);
  }
}

/** Orígenes permitidos, ya parseados. Vacío = reflejar el origen (solo dev/test). */
export const corsOrigins: string[] = config.CORS_ORIGIN.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Solo dev/test: secret fijo para no frenar el arranque local.
export const jwtSecret =
  config.JWT_SECRET || "dev-secret-no-usar-en-produccion-0123456789abcdef";
