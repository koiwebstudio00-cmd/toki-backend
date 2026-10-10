import type { Tx } from "../../lib/db.js";
import { botSettingsSelect } from "../agent/configuration.js";
import type { BotSettingsInput } from "./schemas.js";

export const getBot = (tx: Tx, businessId: string) =>
  tx.botSettings.findUnique({ where: { businessId }, select: botSettingsSelect });

export const saveBot = (tx: Tx, businessId: string, input: BotSettingsInput) =>
  tx.botSettings.upsert({ where: { businessId }, create: { businessId, ...input }, update: input, select: botSettingsSelect });
