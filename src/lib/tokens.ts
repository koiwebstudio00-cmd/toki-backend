import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { jwtSecret } from "../config.js";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;
export const VERIFY_EMAIL_TTL_HOURS = 24;
export const RESET_PASSWORD_TTL_HOURS = 1;

const ISSUER = "toki-api";
export const ADMIN_ACCESS_TTL_SECONDS = 15 * 60;

export interface AccessClaims {
  userId: string;
  email: string;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ email: claims.email, typ: "access" }, jwtSecret, {
    subject: claims.userId,
    issuer: ISSUER,
    expiresIn: ACCESS_TTL_SECONDS,
    algorithm: "HS256"
  });
}

/** Lanza si el token es inválido, expiró o no es de acceso. */
export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, jwtSecret, {
    algorithms: ["HS256"],
    issuer: ISSUER
  }) as jwt.JwtPayload;
  if (payload.typ !== "access" || typeof payload.sub !== "string") {
    throw new Error("Token no es de acceso");
  }
  return { userId: payload.sub, email: String(payload.email ?? "") };
}

export function signAdminToken(claims: AccessClaims & { version: number }): string {
  return jwt.sign({ email: claims.email, typ: "admin-access", ver: claims.version }, jwtSecret, {
    subject: claims.userId, issuer: ISSUER, audience: "toki-admin",
    expiresIn: ADMIN_ACCESS_TTL_SECONDS, algorithm: "HS256"
  });
}

export function verifyAdminToken(token: string): AccessClaims & { version: number } {
  const payload = jwt.verify(token, jwtSecret, {
    algorithms: ["HS256"], issuer: ISSUER, audience: "toki-admin"
  }) as jwt.JwtPayload;
  if (payload.typ !== "admin-access" || typeof payload.sub !== "string" || typeof payload.email !== "string" || !Number.isInteger(payload.ver)) {
    throw new Error("Token no es de superadmin");
  }
  return { userId: payload.sub, email: payload.email, version: Number(payload.ver) };
}

/** Token opaco (refresh, verificación, reset). En la BD solo va su hash. */
export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Comparación en tiempo constante de dos hashes hex. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function addDays(days: number, from = new Date()): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

export function addHours(hours: number, from = new Date()): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}
