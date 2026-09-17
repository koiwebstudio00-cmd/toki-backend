// Auth propia: reemplaza Supabase Auth. docs/api.md §2 y docs/arquitectura.md §4.1.
import { systemCtx, withDb } from "../../lib/db.js";
import { resetPasswordMail, verifyEmailMail } from "../../lib/email-templates.js";
import { ApiError } from "../../lib/errors.js";
import { sendMail } from "../../lib/mailer.js";
import { hashPassword, verifyPassword } from "../../lib/passwords.js";
import {
  ACCESS_TTL_SECONDS,
  addDays,
  addHours,
  randomToken,
  REFRESH_TTL_DAYS,
  RESET_PASSWORD_TTL_HOURS,
  sha256,
  signAccessToken,
  VERIFY_EMAIL_TTL_HOURS
} from "../../lib/tokens.js";
import * as repo from "./repo.js";
import type { LoginInput, RegisterInput } from "./schemas.js";

/**
 * Ventana en la que reusar un refresh recién rotado NO se trata como robo:
 * dos pestañas que refrescan casi a la vez. Pasado este tiempo, reusar un token
 * rotado revoca todas las sesiones del usuario.
 */
const REFRESH_REUSE_GRACE_MS = 10_000;

const INVALID_LINK = "El link no es válido o ya venció. Pedí uno nuevo.";
const INVALID_CREDENTIALS = "Email o contraseña incorrectos.";

type DbUser = NonNullable<Awaited<ReturnType<typeof repo.findUserById>>>;

function fullNameOf(user: Pick<DbUser, "rawUserMetaData">): string | null {
  const meta = user.rawUserMetaData as Record<string, unknown> | null;
  return typeof meta?.full_name === "string" ? meta.full_name : null;
}

export interface SessionBusiness {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  isActive: boolean;
  role: "owner" | "admin" | "staff";
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; fullName: string | null; emailVerified: boolean };
  businesses: SessionBusiness[];
}

async function businessesOf(userId: string, email: string): Promise<SessionBusiness[]> {
  const rows = await withDb({ role: "authenticated", userId, email }, (tx) => repo.listMemberships(tx, userId));
  return rows.map((m) => ({ ...m.business, role: m.role }));
}

async function issueSession(user: DbUser, userAgent: string | undefined): Promise<Session> {
  const refreshToken = randomToken();
  await withDb(systemCtx, async (tx) => {
    await repo.createRefreshToken(tx, {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: addDays(REFRESH_TTL_DAYS),
      userAgent: userAgent?.slice(0, 300)
    });
    await repo.touchLastLogin(tx, user.id);
  });
  return {
    accessToken: signAccessToken({ userId: user.id, email: user.email }),
    refreshToken,
    expiresIn: ACCESS_TTL_SECONDS,
    user: { id: user.id, email: user.email, fullName: fullNameOf(user), emailVerified: Boolean(user.emailVerifiedAt) },
    businesses: await businessesOf(user.id, user.email)
  };
}

// Hash de referencia para igualar tiempos cuando el email no existe (evita
// adivinar qué emails están registrados midiendo la respuesta).
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomToken()));

// ── Registro y verificación ─────────────────────────────────────────────────

export async function register(input: RegisterInput): Promise<void> {
  const passwordHash = await hashPassword(input.password);

  const result = await withDb(systemCtx, async (tx) => {
    const existing = await repo.findUserByEmail(tx, input.email);
    if (existing?.emailVerifiedAt) {
      throw new ApiError("CONFLICT", "Ya existe una cuenta con ese email. Iniciá sesión o recuperá tu contraseña.");
    }
    // Cuenta sin verificar: no se pisa la contraseña (podría no ser el dueño del
    // email); solo se reenvía el link al email real.
    const user = existing ?? (await repo.createUser(tx, { email: input.email, passwordHash, fullName: input.fullName }));
    const token = randomToken();
    await repo.invalidateEmailTokens(tx, user.id, "verify_email");
    await repo.createEmailToken(tx, {
      userId: user.id,
      purpose: "verify_email",
      tokenHash: sha256(token),
      expiresAt: addHours(VERIFY_EMAIL_TTL_HOURS)
    });
    return { user, token };
  });

  // Fuera de la transacción: un SMTP lento nunca deja la BD bloqueada.
  await sendMail(verifyEmailMail(result.user.email, fullNameOf(result.user) ?? input.fullName, result.token));
}

export async function verifyEmail(token: string): Promise<void> {
  await withDb(systemCtx, async (tx) => {
    const consumed = await repo.consumeEmailToken(tx, sha256(token), "verify_email");
    if (!consumed) throw new ApiError("VALIDATION_ERROR", INVALID_LINK);
    await repo.markEmailVerified(tx, consumed.userId);
  });
}

export async function resendVerification(email: string): Promise<void> {
  const result = await withDb(systemCtx, async (tx) => {
    const user = await repo.findUserByEmail(tx, email);
    if (!user || user.emailVerifiedAt) return null; // misma respuesta exista o no
    const token = randomToken();
    await repo.invalidateEmailTokens(tx, user.id, "verify_email");
    await repo.createEmailToken(tx, {
      userId: user.id,
      purpose: "verify_email",
      tokenHash: sha256(token),
      expiresAt: addHours(VERIFY_EMAIL_TTL_HOURS)
    });
    return { user, token };
  });
  if (result) await sendMail(verifyEmailMail(result.user.email, fullNameOf(result.user), result.token));
}

// ── Sesiones ────────────────────────────────────────────────────────────────

export async function login(input: LoginInput, userAgent?: string): Promise<Session> {
  const user = await withDb(systemCtx, (tx) => repo.findUserByEmail(tx, input.email));
  const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password);
  if (!user || !ok) throw new ApiError("UNAUTHORIZED", INVALID_CREDENTIALS);
  // Recién con la contraseña correcta se revela que falta verificar.
  if (!user.emailVerifiedAt) {
    throw new ApiError("EMAIL_NOT_VERIFIED", "Confirmá tu email para entrar. Te mandamos un link cuando te registraste.");
  }
  return issueSession(user, userAgent);
}

export async function refresh(refreshToken: string, userAgent?: string): Promise<Session> {
  const outcome = await withDb(systemCtx, async (tx) => {
    const current = await repo.findRefreshToken(tx, sha256(refreshToken));
    if (!current) return { kind: "invalid" as const };

    if (current.revokedAt) {
      const rotatedLongAgo =
        current.replacedBy && Date.now() - current.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS;
      // Reuso de un token ya rotado: alguien tiene una copia. Se cortan todas las sesiones.
      if (rotatedLongAgo) await repo.revokeAllRefreshTokens(tx, current.userId);
      return { kind: rotatedLongAgo ? ("reused" as const) : ("invalid" as const) };
    }
    if (current.expiresAt <= new Date()) return { kind: "invalid" as const };

    const user = await repo.findUserById(tx, current.userId);
    if (!user?.emailVerifiedAt) return { kind: "invalid" as const };

    const nextToken = randomToken();
    const next = await repo.createRefreshToken(tx, {
      userId: user.id,
      tokenHash: sha256(nextToken),
      expiresAt: addDays(REFRESH_TTL_DAYS),
      userAgent: userAgent?.slice(0, 300)
    });
    // Si otra request rotó este token en paralelo, esta pierde y se descarta.
    const { count } = await repo.revokeRefreshToken(tx, current.id, next.id);
    if (count !== 1) throw new ApiError("UNAUTHORIZED", "Sesión expirada o inválida.");
    return { kind: "ok" as const, user, nextToken };
  });

  if (outcome.kind !== "ok") {
    // Tiene que commitear la revocación en cadena antes de responder 401.
    throw new ApiError("UNAUTHORIZED", "Sesión expirada o inválida.");
  }

  return {
    accessToken: signAccessToken({ userId: outcome.user.id, email: outcome.user.email }),
    refreshToken: outcome.nextToken,
    expiresIn: ACCESS_TTL_SECONDS,
    user: {
      id: outcome.user.id,
      email: outcome.user.email,
      fullName: fullNameOf(outcome.user),
      emailVerified: true
    },
    businesses: await businessesOf(outcome.user.id, outcome.user.email)
  };
}

export async function logout(userId: string, refreshToken: string | undefined, all: boolean): Promise<void> {
  await withDb(systemCtx, async (tx) => {
    if (all) {
      await repo.revokeAllRefreshTokens(tx, userId);
      return;
    }
    if (!refreshToken) return;
    const token = await repo.findRefreshToken(tx, sha256(refreshToken));
    // Solo puede revocar sus propios tokens.
    if (token && token.userId === userId) await repo.revokeRefreshToken(tx, token.id);
  });
}

// ── Recuperación de contraseña ──────────────────────────────────────────────

export async function forgotPassword(email: string): Promise<void> {
  const result = await withDb(systemCtx, async (tx) => {
    const user = await repo.findUserByEmail(tx, email);
    if (!user) return null; // misma respuesta exista o no
    const token = randomToken();
    await repo.invalidateEmailTokens(tx, user.id, "reset_password");
    await repo.createEmailToken(tx, {
      userId: user.id,
      purpose: "reset_password",
      tokenHash: sha256(token),
      expiresAt: addHours(RESET_PASSWORD_TTL_HOURS)
    });
    return { email: user.email, token };
  });
  if (result) await sendMail(resetPasswordMail(result.email, result.token));
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await withDb(systemCtx, async (tx) => {
    const consumed = await repo.consumeEmailToken(tx, sha256(token), "reset_password");
    if (!consumed) throw new ApiError("VALIDATION_ERROR", INVALID_LINK);
    await repo.setPassword(tx, consumed.userId, passwordHash);
    // Usar el link prueba acceso al email.
    await repo.markEmailVerified(tx, consumed.userId);
    await repo.revokeAllRefreshTokens(tx, consumed.userId);
    await repo.invalidateEmailTokens(tx, consumed.userId, "reset_password");
  });
}

// ── Usuario actual ──────────────────────────────────────────────────────────

export async function me(userId: string, email: string, requestedBusinessId?: string) {
  const user = await withDb(systemCtx, (tx) => repo.findUserById(tx, userId));
  if (!user) throw new ApiError("UNAUTHORIZED", "Sesión expirada o inválida.");

  const ctx = { role: "authenticated" as const, userId, email };
  const [profile, businesses] = await Promise.all([
    withDb(ctx, (tx) => repo.findProfile(tx, userId)),
    businessesOf(userId, email)
  ]);

  const currentBusiness =
    (requestedBusinessId && businesses.find((b) => b.id === requestedBusinessId)) || businesses[0] || null;

  return {
    user: { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) },
    profile: {
      fullName: profile?.fullName ?? fullNameOf(user),
      phone: profile?.phone ?? null,
      avatarUrl: profile?.avatarUrl ?? null
    },
    businesses,
    currentBusiness
  };
}
