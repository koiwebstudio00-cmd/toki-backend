// Emails transaccionales por Resend (SMTP). Mismo enfoque que back-lamelas.
// Regla: nunca enviar dentro de una transacción de BD; primero commit, después envío.
import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let _transporter: Transporter | null = null;

function transporter(): Transporter | null {
  if (!config.SMTP_HOST) return null;
  _transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth:
      config.SMTP_USER && config.SMTP_PASS
        ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
        : undefined
  });
  return _transporter;
}

/** Outbox en memoria para tests: permite leer el token del email enviado. */
export const testOutbox: Mail[] = [];

/**
 * Envía por SMTP si hay SMTP_HOST; si no (dev), imprime en consola.
 * Los emails nunca frenan el flujo: los errores se loguean y se sigue.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (config.NODE_ENV === "test") {
    testOutbox.push(mail);
    return;
  }
  const t = transporter();
  if (!t) {
    console.log(`[mail-dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return;
  }
  try {
    await t.sendMail({ from: config.EMAIL_FROM, ...mail });
  } catch (err) {
    console.error("[mail] error enviando email:", err instanceof Error ? err.message : err);
  }
}
