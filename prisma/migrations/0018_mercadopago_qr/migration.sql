alter table public.mp_registers add column external_pos_id text, add column name text;
alter table public.mp_registers alter column store_id drop not null;
create unique index mp_register_external_pos on public.mp_registers(connection_id, external_pos_id);
alter table public.mp_payment_attempts
  add column request_body jsonb,
  add column original_payment_method text not null default 'cash',
  add column next_check_at timestamptz,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column failure_count integer not null default 0,
  add column review_reason text,
  add column cancel_requested boolean not null default false;
create index mp_attempts_due on public.mp_payment_attempts(environment, next_check_at)
  where next_check_at is not null;
create unique index mp_attempts_payment_scope on public.mp_payment_attempts(business_id, order_id, id);
alter table public.payments add column mp_attempt_id uuid unique,
  add constraint payments_mp_attempt_scope foreign key (business_id, order_id, mp_attempt_id)
  references public.mp_payment_attempts(business_id, order_id, id);

-- Protect all writers (dashboard and agent SQL functions), not just the QR route.
create function private.guard_mp_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare trusted boolean := current_setting('role', true) = 'service_role'
  and current_setting('toki.mp_write', true) = 'true';
begin
  if trusted then return new; end if;
  if (new.total is distinct from old.total or new.payment_method is distinct from old.payment_method
      or new.payment_status is distinct from old.payment_status
      or (new.status = 'cancelled' and old.status <> 'cancelled'))
    and exists (select 1 from public.mp_payment_attempts where order_id = old.id and status in ('created','pending','unknown')) then
    raise exception 'Hay un cobro QR pendiente. Cancelalo o verificá el resultado antes de cambiar el pedido.';
  end if;
  if old.payment_method = 'mercadopago' and
     (new.payment_status is distinct from old.payment_status or new.payment_method is distinct from old.payment_method
      or new.total is distinct from old.total) then
    raise exception 'El pago de Mercado Pago se verifica con el proveedor. No se puede modificar manualmente.';
  end if;
  return new;
end $$;
create trigger guard_mp_order before update on public.orders for each row execute function private.guard_mp_order();

create function private.guard_mp_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare target uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
begin
  -- Same lock as attempt creation and mark_order_paid, preventing check/write races.
  perform 1 from public.orders where id = target for update;
  if not coalesce(current_setting('role', true) = 'service_role'
      and current_setting('toki.mp_write', true) = 'true', false)
    and (exists (select 1 from public.orders where id = target and payment_method = 'mercadopago')
      or (tg_op <> 'DELETE' and new.provider = 'mercadopago')
      or (tg_op <> 'INSERT' and old.provider = 'mercadopago')) then
    raise exception 'Los pagos de Mercado Pago solo pueden actualizarse mediante verificación con el proveedor.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger guard_mp_payment before insert or update or delete on public.payments
  for each row execute function private.guard_mp_payment();
