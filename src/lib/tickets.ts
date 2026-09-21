// Tickets de un solo uso para SSE.
//
// EventSource del navegador no manda headers, así que el Bearer no puede viajar
// en la suscripción. El dashboard pide un ticket con su token (POST normal) y
// abre el stream con ?ticket=. El ticket vale 60 segundos, se usa una sola vez
// y solo habilita leer eventos de un negocio: no sirve para ninguna otra ruta.
import { randomToken } from "./tokens.js";

export const TICKET_TTL_SECONDS = 60;

interface Ticket {
  businessId: string;
  userId: string;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

function purge(now: number): void {
  for (const [key, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(key);
  }
}

export function issueTicket(businessId: string, userId: string): { ticket: string; expiresIn: number } {
  const now = Date.now();
  purge(now);
  const ticket = randomToken();
  tickets.set(ticket, { businessId, userId, expiresAt: now + TICKET_TTL_SECONDS * 1_000 });
  return { ticket, expiresIn: TICKET_TTL_SECONDS };
}

/** Consume el ticket: la segunda llamada con el mismo valor devuelve null. */
export function consumeTicket(ticket: string | undefined): Ticket | null {
  if (!ticket) return null;
  const now = Date.now();
  purge(now);
  const found = tickets.get(ticket);
  if (!found) return null;
  tickets.delete(ticket);
  return found.expiresAt > now ? found : null;
}

/** Solo para tests. */
export function clearTickets(): void {
  tickets.clear();
}
