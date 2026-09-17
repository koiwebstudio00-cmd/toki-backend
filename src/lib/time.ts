// Conversión entre columnas time/date de Postgres (Prisma las da como Date en UTC)
// y los strings de la API ("HH:mm", "YYYY-MM-DD"). Sin zonas horarias: una hora
// de apertura es una hora de reloj del negocio, no un instante.

export function timeToString(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(11, 16);
}

export function timeFromString(value: string | null | undefined): Date | null {
  if (!value) return null;
  return new Date(`1970-01-01T${value.length === 5 ? `${value}:00` : value}Z`);
}

export function dateToString(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

export function dateFromString(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}
