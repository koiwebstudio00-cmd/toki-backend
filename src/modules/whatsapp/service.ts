// Conexión de WhatsApp (Zernio) e inbox — docs/api.md §12.
//
// Port de las Edge Functions `zernio-whatsapp-start` y `zernio-whatsapp-complete`.
// Las lecturas van como `authenticated`; la escritura de la integración usa
// `service_role` DESPUÉS de que requireAdmin validó el rol, igual que hacían las
// Edge Functions con la service key.
import type { Prisma } from "@prisma/client";
import { systemCtx, withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import type { BusinessScope } from "../../lib/request.js";
import { zernioFetch } from "../../lib/zernio.js";
import type { CompleteConnectInput, ListConversationsQuery, ListMessagesQuery, StartConnectInput } from "./schemas.js";

interface ZernioProfileResponse {
  profile?: { _id?: string };
  data?: { profile?: { _id?: string } };
}

interface ZernioConnectResponse {
  authUrl?: string;
  url?: string;
  state?: string;
  data?: { authUrl?: string; url?: string };
}

type IntegrationRow = Prisma.WhatsappIntegrationGetPayload<object>;

/** Nunca salen tokens ni metadata cruda: el front solo necesita el estado. */
function toIntegrationDto(row: IntegrationRow | null) {
  if (!row) return { provider: null, isActive: false, phoneNumber: null, connectedAt: null };
  const metadata = (row.providerMetadata ?? {}) as Record<string, unknown>;
  return {
    provider: row.provider,
    isActive: row.isActive,
    phoneNumber: row.phoneNumber,
    connectedAt: typeof metadata.connectedAt === "string" ? metadata.connectedAt : null
  };
}

export async function getIntegration({ ctx, businessId }: BusinessScope) {
  const row = await withDb(ctx, (tx) => tx.whatsappIntegration.findUnique({ where: { businessId } }));
  return toIntegrationDto(row);
}

function readMetadata(row: IntegrationRow | null): Record<string, unknown> {
  const value = row?.providerMetadata;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Una integración vieja de Meta no se pisa sin querer. */
function assertNotLegacy(row: IntegrationRow | null): void {
  if (row?.provider && row.provider !== "zernio") {
    throw new ApiError(
      "CONFLICT",
      "Este negocio tiene una integración de WhatsApp legacy. Revisala antes de conectar Zernio."
    );
  }
}

/**
 * Crea (o reutiliza) el perfil en Zernio, deja la integración en `is_active =
 * false` con el profileId guardado y devuelve la URL para que el dueño conecte
 * su WhatsApp. Recién `complete` la activa.
 */
export async function startConnect({ ctx, businessId }: BusinessScope, input: StartConnectInput) {
  const { business, existing } = await withDb(ctx, async (tx) => ({
    business: await tx.business.findUnique({ where: { id: businessId }, select: { id: true, name: true } }),
    existing: await tx.whatsappIntegration.findUnique({ where: { businessId } })
  }));
  if (!business) throw notFound("No encontramos el negocio.");
  assertNotLegacy(existing);

  const metadata = readMetadata(existing);
  let profileId = typeof metadata.zernioProfileId === "string" ? metadata.zernioProfileId : "";

  if (!profileId) {
    const profile = await zernioFetch<ZernioProfileResponse>("/profiles", {
      method: "POST",
      body: { name: `toki_${businessId}`, description: business.name }
    });
    profileId = profile.profile?._id ?? profile.data?.profile?._id ?? "";
    if (!profileId) throw new ApiError("CONFLICT", "Zernio no devolvió el perfil. Probá de nuevo en un minuto.");
  }

  const nextMetadata = {
    ...metadata,
    zernioProfileId: profileId,
    zernioOnboarding: input.onboarding,
    connectStartedAt: new Date().toISOString(),
    connectRedirectUrl: input.redirectUrl
  };

  await withDb(systemCtx, (tx) =>
    tx.whatsappIntegration.upsert({
      where: { businessId },
      create: { businessId, provider: "zernio", providerMetadata: nextMetadata, isActive: false },
      update: { provider: "zernio", providerMetadata: nextMetadata, isActive: false }
    })
  );

  const connect = await zernioFetch<ZernioConnectResponse>("/connect/whatsapp", {
    query: { profileId, redirect_url: input.redirectUrl, onboarding: input.onboarding }
  });
  const authUrl = connect.authUrl ?? connect.url ?? connect.data?.authUrl ?? connect.data?.url;
  if (!authUrl) throw new ApiError("CONFLICT", "Zernio no devolvió la URL de conexión. Probá de nuevo.");

  return { authUrl, state: connect.state ?? null, profileId };
}

/** Activa la integración. El profileId tiene que ser el mismo que inició la conexión. */
export async function completeConnect({ ctx, businessId }: BusinessScope, input: CompleteConnectInput) {
  const existing = await withDb(ctx, (tx) => tx.whatsappIntegration.findUnique({ where: { businessId } }));
  assertNotLegacy(existing);

  const metadata = readMetadata(existing);
  const startedProfileId = typeof metadata.zernioProfileId === "string" ? metadata.zernioProfileId : "";
  if (startedProfileId && startedProfileId !== input.profileId) {
    throw new ApiError("CONFLICT", "El perfil que devolvió Zernio no coincide con la conexión que iniciaste.");
  }

  const providerMetadata = {
    ...metadata,
    zernioProfileId: input.profileId,
    zernioAccountId: input.accountId,
    callback: input.rawQuery ?? {},
    connectedAt: new Date().toISOString()
  };

  const data = {
    provider: "zernio",
    providerExternalId: input.accountId,
    phoneNumber: input.username ?? null,
    providerMetadata,
    isActive: true
  };

  const row = await withDb(systemCtx, (tx) =>
    tx.whatsappIntegration.upsert({ where: { businessId }, create: { businessId, ...data }, update: data })
  );
  return { success: true as const, integration: toIntegrationDto(row) };
}

// ── Inbox ───────────────────────────────────────────────────────────────────

const caseInclude = {
  order: { select: { id: true, orderCode: true, status: true, total: true, paymentStatus: true } },
  refunds: { orderBy: { requestedAt: "desc" as const } }
} satisfies Prisma.ConversationCaseInclude;

const conversationInclude = {
  customer: { select: { id: true, name: true, phone: true, loyaltyPoints: true } },
  // Agente v3 (0010): por qué se derivó, de qué pedido y si hay que devolver plata.
  currentCase: { include: caseInclude }
} satisfies Prisma.WhatsappConversationInclude;

type CaseRow = Prisma.ConversationCaseGetPayload<{ include: typeof caseInclude }>;

export function toCaseDto(c: CaseRow) {
  return {
    id: c.id,
    reason: c.reason,
    summary: c.summary,
    status: c.status as "open" | "resolved",
    openedAt: c.openedAt,
    resolvedAt: c.resolvedAt,
    resolutionNote: c.resolutionNote,
    order: c.order ? { ...c.order, total: toNumber(c.order.total) } : null,
    refunds: c.refunds.map((r) => ({
      id: r.id,
      amount: toNumber(r.amount),
      reason: r.reason,
      status: r.status as "pending" | "completed" | "rejected",
      originalPaymentMethod: r.originalPaymentMethod,
      destination: (r.destination ?? {}) as { alias?: string; cbu_cvu?: string; holder?: string },
      requestedAt: r.requestedAt,
      completedAt: r.completedAt,
      notes: r.notes
    }))
  };
}

type ConversationRow = Prisma.WhatsappConversationGetPayload<{ include: typeof conversationInclude }>;

function toConversationDto(c: ConversationRow) {
  return {
    id: c.id,
    contactId: c.contactId,
    phone: c.phone,
    status: c.status as "open" | "handoff" | "closed",
    handoffReason: c.handoffReason,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
    customer: c.customer,
    currentCase: c.currentCase ? toCaseDto(c.currentCase) : null
  };
}

export async function listConversations({ ctx, businessId }: BusinessScope, q: ListConversationsQuery) {
  const where: Prisma.WhatsappConversationWhereInput = {
    businessId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.reason ? { handoffReason: q.reason } : {})
  };
  const [rows, total] = await withDb(ctx, async (tx) => [
    await tx.whatsappConversation.findMany({
      where,
      include: conversationInclude,
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit
    }),
    await tx.whatsappConversation.count({ where })
  ]);
  return {
    data: rows.map(toConversationDto),
    meta: { page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) }
  };
}

/**
 * Mensajes de la conversación, del más nuevo al más viejo (`before` pagina hacia
 * atrás), más el último pedido de ese teléfono: es lo que el operador necesita
 * ver arriba del chat cuando toma la conversación.
 */
export async function listMessages({ ctx, businessId }: BusinessScope, conversationId: string, q: ListMessagesQuery) {
  return withDb(ctx, async (tx) => {
    const conversation = await tx.whatsappConversation.findFirst({
      where: { id: conversationId, businessId },
      select: { id: true, phone: true, currentCase: { include: caseInclude } }
    });
    if (!conversation) throw notFound("La conversación no existe.");

    const messages = await tx.whatsappMessage.findMany({
      where: {
        conversationId,
        businessId,
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {})
      },
      orderBy: { createdAt: "desc" },
      take: q.limit
    });

    const lastOrder = await tx.order.findFirst({
      where: {
        businessId,
        OR: [
          { whatsappConversationId: conversationId },
          ...(conversation.phone ? [{ customerPhone: conversation.phone }] : [])
        ]
      },
      orderBy: { createdAt: "desc" },
      select: { orderCode: true, status: true, total: true, createdAt: true }
    });

    return {
      data: messages.map((m) => ({
        id: m.id,
        direction: m.direction as "inbound" | "outbound",
        messageType: m.messageType,
        content: m.content,
        aiIntent: m.aiIntent,
        createdAt: m.createdAt
      })),
      lastOrder: lastOrder ? { ...lastOrder, total: toNumber(lastOrder.total) } : null,
      currentCase: conversation.currentCase ? toCaseDto(conversation.currentCase) : null
    };
  });
}

/** Al devolver la conversación al bot se limpia el motivo; al tomarla, si no había, queda `pedido_humano`. */
export async function setConversationStatus(
  { ctx, businessId }: BusinessScope,
  conversationId: string,
  status: "open" | "handoff" | "closed"
) {
  const row = await withDb(ctx, async (tx) => {
    const current = await tx.whatsappConversation.findFirst({
      where: { id: conversationId, businessId },
      select: { handoffReason: true, currentCaseId: true }
    });
    if (!current) throw notFound("La conversación no existe.");

    const handoffReason =
      status === "open" ? null : status === "handoff" ? (current.handoffReason ?? "pedido_humano") : current.handoffReason;

    // Devolverla al bot cierra el caso abierto: si alguien del local la atendió
    // y la devuelve, el tema quedó resuelto.
    if (status === "open" && current.currentCaseId) {
      await tx.conversationCase.updateMany({
        where: { id: current.currentCaseId, businessId, status: "open" },
        data: { status: "resolved", resolvedAt: new Date(), resolvedBy: ctx.role === "authenticated" ? ctx.userId : null, resolutionNote: "Conversación devuelta al bot." }
      });
    }

    await tx.whatsappConversation.updateMany({
      where: { id: conversationId, businessId },
      data: { status, handoffReason, ...(status === "open" ? { currentCaseId: null } : {}) }
    });
    return tx.whatsappConversation.findUniqueOrThrow({ where: { id: conversationId }, include: conversationInclude });
  });
  return toConversationDto(row);
}
