import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";

/** AAD binds a recoverable provider secret to its business, environment and purpose. */
export function seal(value: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.MP_TOKEN_ENCRYPTION_KEY, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function unseal(value: string, context: string): string {
  try {
    const [version, iv, tag, encrypted, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !encrypted || extra) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(config.MP_TOKEN_ENCRYPTION_KEY, "hex"), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE", "No pudimos acceder a la conexión de Mercado Pago. Contactá a soporte.");
  }
}
