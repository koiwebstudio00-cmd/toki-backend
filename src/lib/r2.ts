// Cloudflare R2 (S3-compatible) — docs/arquitectura.md §7.
// Sin credenciales (dev/test) funciona en modo stub: URLs falsas y borrado no-op.
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export const PRESIGN_TTL_SECONDS = 600;

export type BucketKind = "public" | "private";

export const r2Enabled = Boolean(
  config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY
);

let _client: S3Client | null = null;

function client(): S3Client {
  _client ??= new S3Client({
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    // Desde @aws-sdk/client-s3 3.729 el SDK firma un checksum CRC32 del body
    // vacío en las URLs prefirmadas y R2 rechaza el PUT real. Gotcha resuelto en
    // Lamelas (2026-07-30): WHEN_REQUIRED lo desactiva.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!
    }
  });
  return _client;
}

function bucket(kind: BucketKind): string {
  return kind === "public" ? config.R2_BUCKET_PUBLIC : config.R2_BUCKET_PRIVATE;
}

export type ImageKind = "product" | "category" | "business-logo" | "business-cover";

const IMAGE_FOLDER: Record<ImageKind, string> = {
  product: "products",
  category: "categories",
  "business-logo": "business/logo",
  "business-cover": "business/cover"
};

export const IMAGE_CONTENT_TYPES = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png"
} as const;

export type ImageContentType = keyof typeof IMAGE_CONTENT_TYPES;

/** La key siempre la arma el backend con el negocio del contexto. */
export function newImageKey(businessId: string, kind: ImageKind, contentType: ImageContentType): string {
  return `${businessId}/${IMAGE_FOLDER[kind]}/${randomUUID()}.${IMAGE_CONTENT_TYPES[contentType]}`;
}

export function newPaymentProofKey(businessId: string, orderCode: string | null, ext: string): string {
  return `${businessId}/payment-proofs/${orderCode ?? "sin-pedido"}/${randomUUID()}.${ext}`;
}

/** Comprobante de una devolución que hizo el local (agente v3). Bucket privado. */
export function newRefundProofKey(businessId: string, refundId: string, ext: string): string {
  return `${businessId}/refund-proofs/${refundId}/${randomUUID()}.${ext}`;
}

export function publicUrl(key: string): string {
  const base = config.R2_PUBLIC_URL ?? "http://localhost:3000/dev-r2";
  return `${base.replace(/\/$/, "")}/${key}`;
}

/** Extrae la key de una URL pública propia; null si la URL no es de nuestro bucket. */
export function keyFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const base = (config.R2_PUBLIC_URL ?? "http://localhost:3000/dev-r2").replace(/\/$/, "") + "/";
  return url.startsWith(base) ? url.slice(base.length) : null;
}

export async function presignPut(kind: BucketKind, key: string, contentType: string): Promise<string> {
  if (!r2Enabled) return `http://localhost:3000/dev-r2-upload/${key}?expires=${PRESIGN_TTL_SECONDS}`;
  const cmd = new PutObjectCommand({ Bucket: bucket(kind), Key: key, ContentType: contentType });
  return getSignedUrl(client(), cmd, { expiresIn: PRESIGN_TTL_SECONDS });
}

export async function presignGet(kind: BucketKind, key: string): Promise<string> {
  if (!r2Enabled) return `http://localhost:3000/dev-r2/${key}?expires=${PRESIGN_TTL_SECONDS}`;
  const cmd = new GetObjectCommand({ Bucket: bucket(kind), Key: key });
  return getSignedUrl(client(), cmd, { expiresIn: PRESIGN_TTL_SECONDS });
}

export async function putObject(kind: BucketKind, key: string, body: Uint8Array, contentType: string): Promise<void> {
  if (!r2Enabled) {
    console.log(`[r2-dev] put no-op: ${key} (${body.byteLength} bytes)`);
    return;
  }
  await client().send(new PutObjectCommand({ Bucket: bucket(kind), Key: key, Body: body, ContentType: contentType }));
}

export async function deleteObjects(kind: BucketKind, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (!r2Enabled) {
    if (config.NODE_ENV !== "test") console.log(`[r2-dev] delete no-op: ${keys.join(", ")}`);
    return;
  }
  try {
    await client().send(
      new DeleteObjectsCommand({ Bucket: bucket(kind), Delete: { Objects: keys.map((Key) => ({ Key })) } })
    );
  } catch (err) {
    // No frenar el flujo por un objeto huérfano.
    console.error("[r2] error borrando objetos:", err instanceof Error ? err.message : err);
  }
}

/** Assets por defecto que sirve el front (logo y portada iniciales del negocio). */
export const DEFAULT_ASSET_PREFIX = "/defaults/";

/**
 * Una URL de imagen guardable para un negocio: vacía, un asset por defecto del
 * front, o un objeto de NUESTRO bucket público dentro de la carpeta del negocio.
 * Evita que se guarden URLs arbitrarias o de otro negocio.
 */
export function isAllowedImageUrl(url: string | null | undefined, businessId: string): boolean {
  if (!url) return true;
  if (url.startsWith(DEFAULT_ASSET_PREFIX)) return true;
  const key = keyFromPublicUrl(url);
  return key !== null && key.startsWith(`${businessId}/`) && !key.includes("..");
}

/** Borra del bucket público la imagen anterior si era nuestra y cambió. */
export async function deleteReplacedImage(previous: string | null | undefined, next: string | null | undefined): Promise<void> {
  if (!previous || previous === next) return;
  const key = keyFromPublicUrl(previous);
  if (key) await deleteObjects("public", [key]);
}
