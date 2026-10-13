import { z } from "zod";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";

const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  user_id: z.union([z.number().int().positive().safe(), z.string().regex(/^\d+$/)]).transform(String),
  token_type: z.literal("bearer"),
  expires_in: z.number().int().positive().max(366 * 24 * 3600),
  live_mode: z.boolean(),
  scope: z.string().min(1).max(1024)
});
export type ProviderTokens = z.infer<typeof tokenSchema>;

export class OAuthRejected extends ApiError {
  constructor() { super("CONFLICT", "La autorización de Mercado Pago venció o fue rechazada. Volvé a conectar la cuenta."); }
}

/** No retries here: an authorization code or refresh token may have been consumed. */
export async function requestTokens(grant: Record<string, string>): Promise<ProviderTokens> {
  let response: Response;
  let data: unknown;
  try {
    response = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ...grant, client_id: config.MP_CLIENT_ID, client_secret: config.MP_CLIENT_SECRET,
        test_token: config.MP_ENVIRONMENT === "test" ? "true" : "false"
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error"
    });
    data = await response.json();
  } catch {
    // Never propagate HTTP bodies, token data or fetch errors to logs.
    throw new ApiError("SERVICE_UNAVAILABLE", "No pudimos confirmar la autorización con Mercado Pago. Volvé a conectar la cuenta.");
  }
  if (!response.ok) {
    if ([400, 401, 403].includes(response.status)) throw new OAuthRejected();
    throw new ApiError("SERVICE_UNAVAILABLE", "Mercado Pago no pudo completar la conexión. Intentá nuevamente más tarde.");
  }
  const parsed = tokenSchema.safeParse(data);
  if (!parsed.success || parsed.data.live_mode !== (config.MP_ENVIRONMENT === "production")) {
    throw new ApiError("CONFLICT", "Mercado Pago devolvió una autorización incompatible con el ambiente configurado.");
  }
  const scopes = new Set(parsed.data.scope.split(/\s+/));
  if (!["read", "write", "offline_access"].every(scope => scopes.has(scope))) {
    throw new ApiError("CONFLICT", "La cuenta no autorizó los permisos necesarios de Mercado Pago.");
  }
  return parsed.data;
}
