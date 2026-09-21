// SSE del tablero de pedidos — docs/arquitectura.md §8.
//
// Reemplaza a `supabase.channel(...)` en OrdersPage y DashboardShell. El evento
// solo lleva ids: el front pide el pedido por la API, así RLS sigue decidiendo
// qué se ve. Nunca viaja información del pedido por el canal.
import type { Request, Response } from "express";
import { subscribe } from "../../lib/realtime.js";
import { consumeTicket } from "../../lib/tickets.js";

/** Cada 25 s: mantiene viva la conexión detrás de Traefik y proxies. */
const PING_INTERVAL_MS = 25_000;

function send(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function openEventStream(ticket: string | undefined, req: Request, res: Response): void {
  const session = consumeTicket(ticket);
  if (!session) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "El ticket venció. Pedí uno nuevo y volvé a conectarte." }
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Traefik y nginx bufferean text/event-stream si no se les dice que no.
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();
  send(res, "ready", { businessId: session.businessId });

  const unsubscribe = subscribe(
    session.businessId,
    (event) => send(res, "order", event),
    // Se cayó la conexión con Postgres: el front recarga la lista completa.
    () => send(res, "resync", { reason: "reconnect" })
  );

  const ping = setInterval(() => res.write(": ping\n\n"), PING_INTERVAL_MS);
  ping.unref?.();

  const close = () => {
    clearInterval(ping);
    unsubscribe();
    res.end();
  };
  req.on("close", close);
  res.on("error", close);
}
