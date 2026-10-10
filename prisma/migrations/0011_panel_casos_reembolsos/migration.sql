-- ============================================================================
-- Toki — 0011_panel_casos_reembolsos
-- Fase V3b del agente v3 (toki-agents/docs/12-plan-agente-v3.md §4.4–4.5).
--
-- `register_order_cancellation`: todo lo que pasa cuando se cancela un pedido,
-- en un solo lugar para el panel y para el agente: devuelve stock, el uso del
-- cupón y los puntos, registra quién canceló y por qué, y si estaba pagado deja
-- un reembolso pendiente. No cambia el estado: eso lo hace quien llama
-- (`update_order_status` desde el panel, el agente directo) para que el
-- historial quede con el autor correcto.
--
-- Es SECURITY DEFINER porque el staff puede cancelar pedidos pero RLS no le
-- deja tocar productos, cupones, clientes ni crear reembolsos.
-- ============================================================================

create or replace function public.register_order_cancellation(
  p_order_id uuid,
  p_cancelled_by text,
  p_reason text default null,
  p_conversation_id uuid default null
) returns jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target public.orders;
  paid numeric;
  refund_id uuid;
begin
  select * into target from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Pedido no encontrado';
  end if;
  -- Desde el panel (hay usuario) tiene que ser miembro. Sin usuario es la API
  -- con service_role, que ya validó el negocio.
  if auth.uid() is not null and not private.is_business_member(target.business_id) then
    raise exception 'Pedido no encontrado';
  end if;
  if p_cancelled_by not in ('customer_whatsapp', 'business_dashboard') then
    raise exception 'Origen de cancelación inválido';
  end if;
  -- Idempotente: si ya se registró, no devuelve dos veces.
  if target.cancelled_at is not null then
    return jsonb_build_object('ok', true, 'ya_registrada', true);
  end if;

  perform public.restock_order_items(p_order_id, null);

  if target.coupon_id is not null then
    update public.coupons set used_count = greatest(0, used_count - 1), updated_at = now()
    where id = target.coupon_id;
  end if;

  if target.customer_id is not null then
    update public.customers
    set loyalty_points = greatest(0, loyalty_points - target.loyalty_points_earned),
        total_spent = greatest(0, total_spent - target.total),
        updated_at = now()
    where id = target.customer_id;
  end if;

  update public.orders
  set cancelled_at = now(),
      cancelled_by = p_cancelled_by,
      cancellation_reason = nullif(trim(coalesce(p_reason, '')), ''),
      updated_at = now()
  where id = p_order_id;

  if target.payment_status = 'paid' then
    select coalesce(sum(amount), 0) into paid
    from public.payments where order_id = p_order_id and status = 'paid';
    if paid <= 0 then paid := target.total; end if;
    if paid > 0 then
      insert into public.order_refunds (business_id, order_id, conversation_id, amount, reason, original_payment_method)
      values (target.business_id, p_order_id, coalesce(p_conversation_id, target.whatsapp_conversation_id), paid, 'cancelacion', target.payment_method)
      returning id into refund_id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'refund_id', refund_id, 'refund_amount', case when refund_id is null then null else paid end);
end $$;

revoke all on function public.register_order_cancellation(uuid, text, text, uuid) from public;
grant execute on function public.register_order_cancellation(uuid, text, text, uuid) to authenticated, service_role;

-- Filtro de la bandeja por motivo de derivación y reembolsos pendientes por negocio.
create index if not exists whatsapp_conversations_business_reason_idx
  on public.whatsapp_conversations (business_id, handoff_reason);
