// Emails transaccionales. Texto simple + HTML mínimo (Resend los muestra bien en
// Gmail y Outlook sin CSS externo). Lenguaje directo, para dueños de negocios.
import { config } from "../config.js";
import type { Mail } from "./mailer.js";
import { RESET_PASSWORD_TTL_HOURS, VERIFY_EMAIL_TTL_HOURS } from "./tokens.js";

function frontLink(path: string, token: string): string {
  const url = new URL(path, config.FRONT_URL.replace(/\/$/, "") + "/");
  url.searchParams.set("token", token);
  return url.toString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, paragraphs: string[], cta: { label: string; href: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#1f2937">${p}</p>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td>
<p style="margin:0 0 24px;font-size:22px;font-weight:bold;color:#111827">Toki</p>
<h1 style="margin:0 0 16px;font-size:20px;color:#111827">${title}</h1>
${body}
<p style="margin:24px 0"><a href="${cta.href}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${cta.label}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280">Si el botón no funciona, copiá este link en el navegador:<br><span style="word-break:break-all">${cta.href}</span></p>
</td></tr></table></td></tr></table></body></html>`;
}

export function verifyEmailMail(to: string, fullName: string | null, token: string): Mail {
  const link = frontLink("verify-email", token);
  const hello = fullName ? `Hola ${fullName},` : "Hola,";
  return {
    to,
    subject: "Confirmá tu email para empezar a usar Toki",
    text: `${hello}\n\nConfirmá tu email para activar tu cuenta de Toki (el link vence en ${VERIFY_EMAIL_TTL_HOURS} horas):\n${link}\n\nSi no creaste una cuenta, ignorá este email.`,
    html: layout(
      "Confirmá tu email",
      [escapeHtml(hello), `Tocá el botón para activar tu cuenta. El link vence en ${VERIFY_EMAIL_TTL_HOURS} horas.`, "Si no creaste una cuenta en Toki, ignorá este email."],
      { label: "Confirmar email", href: link }
    )
  };
}

export function resetPasswordMail(to: string, token: string): Mail {
  const link = frontLink("reset-password", token);
  return {
    to,
    subject: "Restablecé tu contraseña de Toki",
    text: `Para elegir una contraseña nueva entrá a este link (vence en ${RESET_PASSWORD_TTL_HOURS} hora):\n${link}\n\nSi no lo pediste, ignorá este email: tu contraseña no cambia.`,
    html: layout(
      "Restablecé tu contraseña",
      [`Tocá el botón para elegir una contraseña nueva. El link vence en ${RESET_PASSWORD_TTL_HOURS} hora.`, "Si no lo pediste, ignorá este email: tu contraseña no cambia."],
      { label: "Elegir contraseña nueva", href: link }
    )
  };
}
