-- ============================================================================
-- Toki — 0003_realtime_notify
-- Reemplaza Supabase Realtime. Cada cambio en orders emite un NOTIFY con solo
-- ids (NOTIFY limita el payload a 8 KB). La API escucha el canal y reenvía por
-- SSE a los dashboards del negocio (docs/arquitectura.md §8).
-- Captura escrituras de cualquier origen: checkout, POS, agente, SQL manual.
-- ============================================================================

create or replace function private.notify_order_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_notify('toki_orders', json_build_object(
    'business_id', coalesce(new.business_id, old.business_id),
    'order_id',    coalesce(new.id, old.id),
    'op',          tg_op
  )::text);
  return null;
end;
$$;

revoke all on function private.notify_order_change() from public, anon, authenticated;

create trigger orders_notify_change
  after insert or update or delete on public.orders
  for each row execute function private.notify_order_change();
