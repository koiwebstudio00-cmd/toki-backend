// Reglas de presentación del panel de admin: estado de WhatsApp y datos personales enmascarados (D3).

export type WhatsappStatus = "connected" | "pending" | "none";

/** `connected`: integración activa. `pending`: conexión iniciada y no completada. `none`: sin integración. */
export function whatsappStatus(row: { provider: string; isActive: boolean; phoneNumber: string | null } | null) {
  if (!row) return { status: "none" as WhatsappStatus, provider: null, phoneNumber: null };
  return {
    status: (row.isActive ? "connected" : "pending") as WhatsappStatus,
    provider: row.provider,
    phoneNumber: row.phoneNumber,
  };
}

/** Teléfono de cliente: solo los últimos 4 dígitos (decisión D3). */
export function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.length > 4 ? `•••• ${digits.slice(-4)}` : "••••";
}
