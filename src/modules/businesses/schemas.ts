import { z } from "zod";
import { clockTime, isoDate, money, optionalText } from "../../lib/validation.js";

// Slugs que chocarían con rutas del front (/:businessSlug es el menú público).
export const RESERVED_SLUGS = new Set([
  "login", "register", "onboarding", "dashboard", "forgot-password", "reset-password",
  "verify-email", "api", "admin", "app", "www", "toki", "static", "assets", "defaults"
]);

export const slugSchema = z
  .string({ required_error: "Ingresá el link público." })
  .trim()
  .toLowerCase()
  .min(3, "El link tiene que tener al menos 3 caracteres.")
  .max(60, "El link es demasiado largo.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Usá solo letras minúsculas, números y guiones.")
  .refine((s) => !RESERVED_SLUGS.has(s), "Ese link no está disponible. Probá con otro.");

export const createBusinessSchema = z.object({
  name: z.string({ required_error: "Ingresá el nombre del negocio." }).trim().min(2, "Ingresá el nombre del negocio.").max(80),
  slug: slugSchema,
  phone: optionalText(40),
  address: optionalText(200),
  city: optionalText(80),
  description: optionalText(500)
});

const imageUrl = z.string().trim().max(1000).nullable().optional();

export const updateBusinessSchema = z
  .object({
    name: z.string().trim().min(2, "Ingresá el nombre del negocio.").max(80).optional(),
    slug: slugSchema.optional(),
    description: optionalText(500),
    businessType: optionalText(60),
    logoUrl: imageUrl,
    coverUrl: imageUrl,
    phone: optionalText(40),
    whatsappPhone: optionalText(40),
    address: optionalText(200),
    city: optionalText(80),
    timezone: z.string().trim().min(1).max(60).optional(),
    estimatedDeliveryMinutes: z.coerce.number().int().min(1, "El tiempo de entrega tiene que ser mayor a cero.").max(600).optional(),
    minimumOrderAmount: money("El pedido mínimo").optional(),
    deliveryFee: money("El costo de envío").optional(),
    isActive: z.boolean().optional()
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "No hay cambios para guardar.")
  .refine((v) => v.timezone === undefined || isValidTimezone(v.timezone), { message: "Zona horaria inválida.", path: ["timezone"] });

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("es-AR", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const statusSchema = z.object({ manualStatus: z.enum(["auto", "open", "closed"]) });

const hourSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  isOpen: z.boolean(),
  opensAt: clockTime.nullable().optional(),
  closesAt: clockTime.nullable().optional(),
  opensAt2: clockTime.nullable().optional(),
  closesAt2: clockTime.nullable().optional()
});

export const hoursSchema = z
  .object({ hours: z.array(hourSchema).length(7, "Mandá los 7 días de la semana.") })
  .superRefine(({ hours }, ctx) => {
    const days = new Set(hours.map((h) => h.dayOfWeek));
    if (days.size !== 7) ctx.addIssue({ code: "custom", path: ["hours"], message: "Cada día tiene que aparecer una sola vez." });
    hours.forEach((h, i) => {
      if (!h.isOpen) return;
      if (!h.opensAt || !h.closesAt) {
        ctx.addIssue({ code: "custom", path: ["hours", i, "opensAt"], message: "Completá la apertura y el cierre." });
      }
      if (Boolean(h.opensAt2) !== Boolean(h.closesAt2)) {
        ctx.addIssue({ code: "custom", path: ["hours", i, "opensAt2"], message: "Completá la apertura y el cierre del segundo turno." });
      }
      if (h.opensAt2 && h.closesAt && h.opensAt2 <= h.closesAt) {
        ctx.addIssue({ code: "custom", path: ["hours", i, "opensAt2"], message: "El segundo turno tiene que empezar después del cierre del primero." });
      }
    });
  });

const specialHourSchema = z.object({
  date: isoDate,
  isClosed: z.boolean(),
  opensAt: clockTime.nullable().optional(),
  closesAt: clockTime.nullable().optional(),
  note: optionalText(200)
});

export const specialHoursSchema = z
  .object({ specialHours: z.array(specialHourSchema).max(200, "Demasiados horarios especiales.") })
  .superRefine(({ specialHours }, ctx) => {
    const seen = new Set<string>();
    specialHours.forEach((h, i) => {
      if (seen.has(h.date)) ctx.addIssue({ code: "custom", path: ["specialHours", i, "date"], message: "Hay dos horarios especiales para el mismo día." });
      seen.add(h.date);
      if (!h.isClosed && (!h.opensAt || !h.closesAt)) {
        ctx.addIssue({ code: "custom", path: ["specialHours", i, "opensAt"], message: "Completá los horarios especiales abiertos." });
      }
    });
  });

export const specialHoursQuery = z.object({ from: isoDate.optional() });

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;
export type HoursInput = z.infer<typeof hoursSchema>["hours"];
export type SpecialHoursInput = z.infer<typeof specialHoursSchema>["specialHours"];
