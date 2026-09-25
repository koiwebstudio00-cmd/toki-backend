// Armado del contexto v3 del agente: reloj del negocio, carta compacta con ids
// cortos y textos legibles del pedido. Funciones puras (sin BD) para poder
// probarlas sin levantar Postgres.

// ── Constantes ──────────────────────────────────────────────────────────────

/** Hasta cuántos productos disponibles la carta va completa en el contexto. */
export const MENU_FULL_MAX_PRODUCTS = 50;

/** Un borrador sin cambios durante estas horas se descarta. */
export const DRAFT_TTL_HOURS = 4;

/** Nombre del asistente cuando el negocio no configuró otro. */
export const DEFAULT_BOT_NAME = "Sofi";

const SHORT_REF_LENGTHS = [6, 8] as const;
const DESCRIPTION_MAX = 120;
const FEATURED_IN_SUMMARY = 8;

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// ── Reloj ───────────────────────────────────────────────────────────────────

export interface ScheduleWindow {
  date: string; // "YYYY-MM-DD"
  opens: string; // "HH:MM"
  closes: string; // "HH:MM"
}

export interface Clock {
  timezone: string;
  now: string; // "YYYY-MM-DDTHH:MM", hora local del negocio
  now_label: string; // "jueves 25/09, 16:23"
  is_open: boolean;
  /** 'auto' sigue los horarios; 'open'/'closed' es el interruptor manual del panel. */
  manual_status: string;
  /** Si está abierto por horario: a qué hora cierra ("23:30"). */
  closes_at: string | null;
  /** Si está cerrado por horario: cuándo abre. `null` si no abre en 7 días o está cerrado a mano. */
  next_open: { at: string; label: string } | null;
}

const MINUTE = 60_000;

/** "YYYY-MM-DD" + "HH:MM" → minutos, tratando la hora local como si fuera UTC (solo para comparar). */
function localMinutes(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00Z`) / MINUTE;
}

function splitLocal(value: string): { date: string; time: string } {
  return { date: value.slice(0, 10), time: value.slice(11, 16) };
}

function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function ddmm(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 1440 * MINUTE).toISOString().slice(0, 10);
}

/** "hoy a las 19:00", "mañana a las 12:00", "el lunes 28/09 a las 12:00". */
export function openingLabel(today: string, date: string, time: string): string {
  if (date === today) return `hoy a las ${time}`;
  if (date === addDays(today, 1)) return `mañana a las ${time}`;
  return `el ${WEEKDAYS[dayOfWeek(date)]} ${ddmm(date)} a las ${time}`;
}

export function buildClock(input: {
  timezone: string;
  manualStatus: string;
  isOpen: boolean;
  nowLocal: string;
  windows: ScheduleWindow[];
}): Clock {
  const { date: today, time } = splitLocal(input.nowLocal);
  const now = localMinutes(today, time);

  // Cada turno como intervalo [inicio, fin]. Si cierra a una hora menor o igual
  // a la de apertura, cruza la medianoche.
  const intervals = input.windows.map((w) => {
    const start = localMinutes(w.date, w.opens);
    let end = localMinutes(w.date, w.closes);
    if (end <= start) end += 1440;
    return { start, end, date: w.date, opens: w.opens, closes: w.closes };
  });

  let closesAt: string | null = null;
  let nextOpen: Clock["next_open"] = null;

  if (input.manualStatus === "auto") {
    const current = intervals.find((i) => i.start <= now && now <= i.end);
    if (input.isOpen && current) closesAt = current.closes;
    if (!input.isOpen) {
      const next = intervals.filter((i) => i.start > now).sort((a, b) => a.start - b.start)[0];
      if (next) nextOpen = { at: `${next.date}T${next.opens}`, label: openingLabel(today, next.date, next.opens) };
    }
  }

  return {
    timezone: input.timezone,
    now: input.nowLocal,
    now_label: `${WEEKDAYS[dayOfWeek(today)]} ${ddmm(today)}, ${time}`,
    is_open: input.isOpen,
    manual_status: input.manualStatus,
    closes_at: closesAt,
    next_open: nextOpen
  };
}

// ── Ids cortos ──────────────────────────────────────────────────────────────

/**
 * Id corto para cada UUID: los primeros 6 caracteres, u 8 si 6 chocan con otro
 * id del mismo negocio, o el UUID completo si también chocan con 8. `space` son
 * todos los ids donde se van a resolver (productos y valores de opción).
 */
export function shortRefs(space: string[]): Map<string, string> {
  const refs = new Map<string, string>();
  const pending = new Set(space.map((id) => id.toLowerCase()));
  for (const length of SHORT_REF_LENGTHS) {
    const counts = new Map<string, number>();
    for (const id of space) {
      const prefix = id.toLowerCase().slice(0, length);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    for (const id of [...pending]) {
      const prefix = id.slice(0, length);
      if (counts.get(prefix) === 1) {
        refs.set(id, prefix);
        pending.delete(id);
      }
    }
  }
  for (const id of pending) refs.set(id, id);
  return refs;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isFullUuid(ref: string): boolean {
  return UUID.test(ref.toLowerCase());
}

// ── Carta ───────────────────────────────────────────────────────────────────

export interface MenuProductInput {
  id: string;
  name: string;
  description: string | null;
  price: number;
  isFeatured: boolean;
  category: { name: string; sortOrder: number } | null;
  options: {
    name: string;
    isRequired: boolean;
    minSelect: number;
    maxSelect: number;
    values: { id: string; name: string; priceDelta: number }[];
  }[];
}

export interface MenuProduct {
  ref: string;
  name: string;
  price: number;
  description?: string;
  options?: {
    name: string;
    required: boolean;
    min: number;
    max: number;
    values: { ref: string; name: string; price_delta: number }[];
  }[];
}

export type Menu =
  | { mode: "full"; product_count: number; categories: { name: string; products: MenuProduct[] }[] }
  | {
      mode: "summary";
      product_count: number;
      categories: { name: string; product_count: number; price_from: number }[];
      featured: MenuProduct[];
    };

const NO_CATEGORY = "Otros";

function shorten(text: string | null): string | undefined {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > DESCRIPTION_MAX ? `${clean.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : clean;
}

function toMenuProduct(p: MenuProductInput, refs: Map<string, string>): MenuProduct {
  const ref = (id: string) => refs.get(id.toLowerCase()) ?? id;
  const options = p.options
    .filter((o) => o.values.length > 0)
    .map((o) => ({
      name: o.name,
      required: o.isRequired,
      min: o.minSelect,
      max: o.maxSelect,
      values: o.values.map((v) => ({ ref: ref(v.id), name: v.name, price_delta: v.priceDelta }))
    }));
  return {
    ref: ref(p.id),
    name: p.name,
    price: p.price,
    ...(shorten(p.description) ? { description: shorten(p.description) } : {}),
    ...(options.length ? { options } : {})
  };
}

/** Agrupa por categoría respetando el orden del menú web. */
function byCategory(products: MenuProductInput[]) {
  const groups = new Map<string, { name: string; sortOrder: number; products: MenuProductInput[] }>();
  for (const p of products) {
    const name = p.category?.name ?? NO_CATEGORY;
    const group = groups.get(name) ?? { name, sortOrder: p.category?.sortOrder ?? Number.MAX_SAFE_INTEGER, products: [] };
    group.products.push(p);
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Carta para el prompt. Hasta MENU_FULL_MAX_PRODUCTS va completa, con ids
 * cortos y opciones; con más, un resumen por categoría y los destacados (el
 * agente busca el resto con `buscar_productos`).
 */
export function buildMenu(products: MenuProductInput[], refs: Map<string, string>): Menu {
  const groups = byCategory(products);
  if (products.length <= MENU_FULL_MAX_PRODUCTS) {
    return {
      mode: "full",
      product_count: products.length,
      categories: groups.map((g) => ({ name: g.name, products: g.products.map((p) => toMenuProduct(p, refs)) }))
    };
  }
  const featured = products.filter((p) => p.isFeatured).slice(0, FEATURED_IN_SUMMARY);
  return {
    mode: "summary",
    product_count: products.length,
    categories: groups.map((g) => ({
      name: g.name,
      product_count: g.products.length,
      price_from: Math.min(...g.products.map((p) => p.price))
    })),
    featured: featured.map((p) => toMenuProduct(p, refs))
  };
}

// ── Pedido ──────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(["pending", "confirmed", "preparing", "ready", "out_for_delivery"]);

/** Estado del pedido como se lo diría una persona. */
export function statusLabel(status: string, orderType: string | null | undefined): string {
  switch (status) {
    case "pending":
      return "recibido, esperando que el local lo acepte";
    case "confirmed":
      return "aceptado por el local";
    case "preparing":
      return "en preparación";
    case "ready":
      return orderType === "delivery" ? "listo, esperando al repartidor" : "listo para retirar";
    case "out_for_delivery":
      return "en camino";
    case "delivered":
      return "entregado";
    case "cancelled":
      return "cancelado";
    default:
      return status;
  }
}

/** Hora estimada ("21:10") en la zona del negocio, solo para pedidos en curso. */
export function orderEta(input: {
  status: string;
  createdAt: string | Date;
  estimatedMinutes: number | null | undefined;
  timezone: string;
}): string | null {
  if (!ACTIVE_STATUSES.has(input.status) || !input.estimatedMinutes) return null;
  const created = new Date(input.createdAt).getTime();
  if (Number.isNaN(created)) return null;
  const eta = new Date(created + input.estimatedMinutes * MINUTE);
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: input.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(eta);
}

/** "YYYY-MM-DDTHH:MM" local + minutos → "HH:MM". Para pedidos que se preparan al abrir. */
export function etaFromLocal(at: string, minutes: number): string {
  return new Date(Date.parse(`${at}:00Z`) + minutes * MINUTE).toISOString().slice(11, 16);
}

// ── Tono ────────────────────────────────────────────────────────────────────

/** `bot_settings.tone` es texto libre; los valores de fábrica se traducen. */
export function toneLabel(tone: string | null | undefined): string {
  const value = (tone ?? "").trim();
  const known: Record<string, string> = {
    friendly: "cercano y claro",
    formal: "formal",
    casual: "casual"
  };
  return known[value.toLowerCase()] ?? (value || known.friendly!);
}
