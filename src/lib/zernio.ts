// Cliente delgado sobre la API de Zernio. Copiado de back-lamelas.
// La API key nunca se expone al front ni se loguea.
import { config } from "../config.js";
import { ApiError, type ErrorCode } from "./errors.js";

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  402: "CONFLICT",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "VALIDATION_ERROR",
  429: "RATE_LIMITED"
};

export interface ZernioErrorBody {
  error?: string;
  type?: string;
  code?: string;
  details?: Record<string, unknown>;
}

/** Conserva el código estable de Zernio para resolver casos recuperables. */
export class ZernioApiError extends ApiError {
  readonly zernioCode?: string;

  constructor(code: ErrorCode, message: string, zernioCode?: string) {
    super(code, message);
    this.zernioCode = zernioCode;
  }
}

function apiKey(): string {
  if (!config.ZERNIO_API_KEY) throw new ApiError("INTERNAL", "Falta configurar ZERNIO_API_KEY.");
  return config.ZERNIO_API_KEY;
}

export async function zernioFetch<T>(
  path: string,
  init: { method?: string; query?: Record<string, string | undefined>; body?: unknown; idempotencyKey?: string } = {}
): Promise<T> {
  const url = new URL(`${config.ZERNIO_BASE_URL.replace(/\/$/, "")}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method: init.method ?? "GET",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {})
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });

  if (!res.ok) {
    let body: ZernioErrorBody = {};
    try {
      body = (await res.json()) as ZernioErrorBody;
    } catch {
      // Respuesta no-JSON: sin detalle adicional.
    }
    throw new ZernioApiError(
      STATUS_TO_CODE[res.status] ?? "CONFLICT",
      `Zernio rechazó la solicitud (${body.code ?? res.status}).`,
      body.code
    );
  }

  return res.json() as Promise<T>;
}

/** Descarga un adjunto (comprobantes). Límite de tamaño para no llenar memoria. */
export async function zernioDownload(
  mediaUrl: string,
  maxBytes = 10 * 1024 * 1024
): Promise<{ body: Uint8Array; contentType: string }> {
  const url = trustedWhatsappMediaUrl(mediaUrl);
  const res = await fetch(url, {
    redirect: "error",
    headers: { Authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new ApiError("CONFLICT", `No se pudo descargar el adjunto (${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new ApiError("VALIDATION_ERROR", "El adjunto supera el tamaño permitido.");
  if (!res.body) throw new ApiError("CONFLICT", "El adjunto está vacío.");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new ApiError("VALIDATION_ERROR", "El adjunto supera el tamaño permitido.");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { body, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

/** Never send the team's credential to a URL chosen by a customer or model. */
export function trustedWhatsappMediaUrl(value: string, accountId?: string): string {
  const url = new URL(value);
  const base = new URL(config.ZERNIO_BASE_URL);
  const prefix = `${base.pathname.replace(/\/$/, "")}/whatsapp/media/`;
  if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password ||
    !url.pathname.startsWith(prefix) || !/^[a-zA-Z0-9_-]+$/.test(url.pathname.slice(prefix.length))) {
    throw new ApiError("VALIDATION_ERROR", "El adjunto no pertenece al canal de WhatsApp autorizado.");
  }
  if (accountId) { url.search = ""; url.searchParams.set("accountId", accountId); }
  url.hash = "";
  return url.toString();
}
