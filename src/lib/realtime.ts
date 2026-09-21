// Tiempo real — docs/arquitectura.md §8.
//
// Reemplaza a Supabase Realtime. La migración 0003 pone un trigger en `orders`
// que emite NOTIFY 'toki_orders' con {business_id, order_id, op}. Acá se abre
// UNA conexión dedicada que escucha ese canal y reparte a los dashboards
// suscriptos por SSE.
//
// Por qué una conexión aparte del pool de Prisma: LISTEN vive en la sesión de
// Postgres, y el pool puede devolver otra conexión en cualquier momento.
import { Client } from "pg";
import { config } from "../config.js";

export const ORDERS_CHANNEL = "toki_orders";

export interface OrderEvent {
  orderId: string;
  op: "INSERT" | "UPDATE" | "DELETE";
}

type Listener = (event: OrderEvent) => void;

/** Aviso de que se perdió la conexión: el cliente vuelve a pedir la lista. */
type ResyncListener = () => void;

interface Subscriber {
  businessId: string;
  onEvent: Listener;
  onResync: ResyncListener;
}

const subscribers = new Set<Subscriber>();

let client: Client | null = null;
let connecting: Promise<void> | null = null;
let stopped = false;
let retryDelayMs = 1_000;
let retryTimer: NodeJS.Timeout | null = null;

const MAX_RETRY_MS = 30_000;

function listenUrl(): string {
  return config.DATABASE_URL_LISTEN || config.DATABASE_URL;
}

function handleNotification(payload: string | undefined): void {
  if (!payload) return;
  let parsed: { business_id?: string; order_id?: string; op?: string };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  const { business_id: businessId, order_id: orderId, op } = parsed;
  if (!businessId || !orderId) return;
  const event: OrderEvent = { orderId, op: (op as OrderEvent["op"]) ?? "UPDATE" };
  for (const sub of subscribers) {
    if (sub.businessId === businessId) sub.onEvent(event);
  }
}

function scheduleReconnect(): void {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
    void ensureListening();
  }, retryDelayMs);
  retryTimer.unref?.();
}

/** Abre (o reusa) la conexión de LISTEN. Reintenta sola si se cae. */
export async function ensureListening(): Promise<void> {
  if (stopped || client || subscribers.size === 0) return;
  if (connecting) return connecting;

  connecting = (async () => {
    const next = new Client({ connectionString: listenUrl(), application_name: "toki-api-listen" });
    next.on("notification", (msg) => handleNotification(msg.payload));
    next.on("error", (err) => {
      console.error("[realtime] conexión caída:", err instanceof Error ? err.message : err);
      client = null;
      next.end().catch(() => {});
      for (const sub of subscribers) sub.onResync();
      scheduleReconnect();
    });
    await next.connect();
    await next.query(`listen ${ORDERS_CHANNEL}`);
    client = next;
    retryDelayMs = 1_000;
  })()
    .catch((err) => {
      console.error("[realtime] no se pudo escuchar:", err instanceof Error ? err.message : err);
      client = null;
      scheduleReconnect();
    })
    .finally(() => {
      connecting = null;
    });

  return connecting;
}

/** Suscribe un dashboard. Devuelve la función para desuscribir. */
export function subscribe(businessId: string, onEvent: Listener, onResync: ResyncListener): () => void {
  const sub: Subscriber = { businessId, onEvent, onResync };
  subscribers.add(sub);
  stopped = false;
  void ensureListening();
  return () => {
    subscribers.delete(sub);
  };
}

export function subscriberCount(): number {
  return subscribers.size;
}

/** Cierre ordenado del server. */
export async function stopListening(): Promise<void> {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  subscribers.clear();
  const current = client;
  client = null;
  if (current) await current.end().catch(() => {});
}

/** Solo para tests: simula un NOTIFY sin tocar la base. */
export function emitForTests(businessId: string, event: OrderEvent): void {
  handleNotification(JSON.stringify({ business_id: businessId, order_id: event.orderId, op: event.op }));
}
