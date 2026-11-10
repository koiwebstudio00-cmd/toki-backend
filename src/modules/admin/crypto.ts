import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";

function key() {
  if (!/^[a-f0-9]{64}$/i.test(config.ADMIN_AUTH_ENCRYPTION_KEY)) {
    throw new ApiError("SERVICE_UNAVAILABLE", "Falta configurar la clave de seguridad de Toki Admin en la API.");
  }
  return Buffer.from(config.ADMIN_AUTH_ENCRYPTION_KEY, "hex");
}
export function sealAdminSecret(secret: string, userId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from("toki-admin:totp:" + userId));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function unsealAdminSecret(value: string, userId: string) {
  const secretKey = key();
  try {
    const [version, iv, tag, encrypted, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !encrypted || extra) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", secretKey, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from("toki-admin:totp:" + userId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE", "No pudimos abrir la configuración del autenticador. Contactá al administrador.");
  }
}
