// Medios de pago, fidelización y bot. docs/api.md §5.
// Todas las tablas tienen como mucho una fila por negocio (salvo FAQs): si no
// existe, el GET devuelve los defaults de la tabla y el PUT la crea.
import { withDb } from "../../lib/db.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { toNumber } from "../../lib/money.js";
import type { BusinessScope } from "../../lib/request.js";
import type {
  BotSettingsInput,
  CreateFaqInput,
  LoyaltySettingsInput,
  PaymentSettingsInput,
  UpdateFaqInput
} from "./schemas.js";

// ── Pagos ───────────────────────────────────────────────────────────────────

const paymentSelect = {
  cashEnabled: true,
  transferEnabled: true,
  transferCbu: true,
  transferAlias: true,
  transferHolder: true,
  transferBank: true,
  mercadopagoEnabled: true
} as const;

const PAYMENT_DEFAULTS = {
  cashEnabled: true,
  transferEnabled: true,
  transferCbu: null,
  transferAlias: null,
  transferHolder: null,
  transferBank: null,
  mercadopagoEnabled: false
};

export async function getPaymentSettings({ ctx, businessId }: BusinessScope) {
  const row = await withDb(ctx, (tx) => tx.paymentSettings.findUnique({ where: { businessId }, select: paymentSelect }));
  return row ?? PAYMENT_DEFAULTS;
}

export async function upsertPaymentSettings({ ctx, businessId }: BusinessScope, input: PaymentSettingsInput) {
  const data = {
    cashEnabled: input.cashEnabled,
    transferEnabled: input.transferEnabled,
    transferCbu: input.transferCbu ?? null,
    transferAlias: input.transferAlias ?? null,
    transferHolder: input.transferHolder ?? null,
    transferBank: input.transferBank ?? null,
    mercadopagoEnabled: false
  };
  return withDb(ctx, (tx) =>
    tx.paymentSettings.upsert({ where: { businessId }, create: { businessId, ...data }, update: data, select: paymentSelect })
  );
}

// ── Fidelización ────────────────────────────────────────────────────────────

const LOYALTY_DEFAULTS = { isEnabled: false, pointsPerCurrency: 0.01, pointsPerOrder: 0, redeemRate: 10, minPointsToRedeem: 100 };

function toLoyaltyDto(row: { isEnabled: boolean; pointsPerCurrency: unknown; pointsPerOrder: number; redeemRate: unknown; minPointsToRedeem: number }) {
  return {
    isEnabled: row.isEnabled,
    pointsPerCurrency: toNumber(row.pointsPerCurrency as number),
    pointsPerOrder: row.pointsPerOrder,
    redeemRate: toNumber(row.redeemRate as number),
    minPointsToRedeem: row.minPointsToRedeem
  };
}

export async function getLoyalty({ ctx, businessId }: BusinessScope) {
  const row = await withDb(ctx, (tx) => tx.loyaltySettings.findUnique({ where: { businessId } }));
  return row ? toLoyaltyDto(row) : LOYALTY_DEFAULTS;
}

export async function upsertLoyalty({ ctx, businessId }: BusinessScope, input: LoyaltySettingsInput) {
  const row = await withDb(ctx, (tx) =>
    tx.loyaltySettings.upsert({ where: { businessId }, create: { businessId, ...input }, update: input })
  );
  return toLoyaltyDto(row);
}

// ── Bot ─────────────────────────────────────────────────────────────────────

const botSelect = { isEnabled: true, botName: true, tone: true, fallbackMessage: true, handoffEnabled: true } as const;

export async function getBotSettings({ ctx, businessId }: BusinessScope) {
  const row = await withDb(ctx, (tx) => tx.botSettings.findUnique({ where: { businessId }, select: botSelect }));
  // create_business_with_owner siempre crea la fila; si falta, se crea con defaults.
  return row ?? { isEnabled: true, botName: "Toki", tone: "friendly", fallbackMessage: "Te derivo con una persona del equipo para que pueda ayudarte.", handoffEnabled: true };
}

export async function updateBotSettings({ ctx, businessId }: BusinessScope, input: BotSettingsInput) {
  return withDb(ctx, (tx) =>
    tx.botSettings.upsert({ where: { businessId }, create: { businessId, ...input }, update: input, select: botSelect })
  );
}

// ── FAQs ────────────────────────────────────────────────────────────────────

const faqSelect = { id: true, question: true, answer: true, isActive: true, createdAt: true, updatedAt: true } as const;

export async function listFaqs({ ctx, businessId }: BusinessScope) {
  return withDb(ctx, (tx) => tx.botFaq.findMany({ where: { businessId }, orderBy: { createdAt: "asc" }, select: faqSelect }));
}

export async function createFaq({ ctx, businessId }: BusinessScope, input: CreateFaqInput) {
  return withDb(ctx, async (tx) => {
    if ((await tx.botFaq.count({ where: { businessId } })) >= 200) {
      throw new ApiError("VALIDATION_ERROR", "Llegaste al máximo de 200 preguntas frecuentes.");
    }
    return tx.botFaq.create({ data: { businessId, ...input }, select: faqSelect });
  });
}

export async function updateFaq({ ctx, businessId }: BusinessScope, id: string, input: UpdateFaqInput) {
  return withDb(ctx, async (tx) => {
    const { count } = await tx.botFaq.updateMany({ where: { id, businessId }, data: input });
    if (count === 0) throw notFound("La pregunta frecuente no existe.");
    return tx.botFaq.findUniqueOrThrow({ where: { id }, select: faqSelect });
  });
}

export async function deleteFaq({ ctx, businessId }: BusinessScope, id: string) {
  const { count } = await withDb(ctx, (tx) => tx.botFaq.deleteMany({ where: { id, businessId } }));
  if (count === 0) throw notFound("La pregunta frecuente no existe.");
}
