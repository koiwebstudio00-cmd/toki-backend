-- ============================================================================
-- Toki — 0006_payment_proof_idempotencia
-- El comprobante de pago llega por el webhook de WhatsApp, y un webhook se
-- reintenta. Sin una guarda, el mismo comprobante se guardaba dos veces (dos
-- archivos en R2 y dos filas para revisar).
--
-- Misma solución que ya usa `whatsapp_messages`: guardar el id del mensaje del
-- proveedor y un índice único parcial por negocio.
-- ============================================================================

alter table public.order_payment_proofs
  add column if not exists provider_message_id text;

comment on column public.order_payment_proofs.provider_message_id is
  'Id del mensaje en el proveedor (Zernio). Único por negocio: guarda de idempotencia del webhook.';

create unique index if not exists uq_order_payment_proofs_provider_message_id
  on public.order_payment_proofs (business_id, provider_message_id)
  where provider_message_id is not null;
