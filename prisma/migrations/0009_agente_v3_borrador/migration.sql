-- ============================================================================
-- Toki — 0009_agente_v3_borrador
-- Fase V2 del agente v3 (toki-agents/docs/12-plan-agente-v3.md), B6.
--
-- `agent_draft_set_details`: cuando el cliente pasa de envío a retiro, la
-- dirección del borrador se borra. Es la única diferencia con la versión de
-- 0001; el resto de la función queda igual.
-- ============================================================================

create or replace function public.agent_draft_set_details(p_business_id uuid, p_conversation_id uuid, p_customer_name text DEFAULT NULL::text, p_order_type text DEFAULT NULL::text, p_delivery_address text DEFAULT NULL::text, p_payment_method text DEFAULT NULL::text, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  draft public.whatsapp_order_drafts;
  pay public.payment_settings;
  -- Prefijo v_ a proposito: 'order_type' y 'payment_method' son nombres de
  -- columna del UPDATE de mas abajo y plpgsql aborta por ambiguedad.
  v_order_type public.order_type;
  v_payment public.payment_method;
begin
  if p_order_type is not null and p_order_type <> '' then
    if p_order_type not in ('delivery', 'takeaway') then
      return jsonb_build_object('ok', false, 'error', 'La entrega tiene que ser delivery o takeaway.');
    end if;
    v_order_type := p_order_type::public.order_type;
  end if;

  if p_payment_method is not null and p_payment_method <> '' then
    if p_payment_method not in ('cash', 'transfer', 'mercadopago') then
      return jsonb_build_object('ok', false, 'error', 'Ese metodo de pago no existe.');
    end if;
    select * into pay from public.payment_settings where business_id = p_business_id;
    if (p_payment_method = 'cash' and not coalesce(pay.cash_enabled, true))
       or (p_payment_method = 'transfer' and not coalesce(pay.transfer_enabled, true))
       or (p_payment_method = 'mercadopago' and not coalesce(pay.mercadopago_enabled, false)) then
      return jsonb_build_object('ok', false, 'error', 'Ese metodo de pago no esta habilitado en este local.');
    end if;
    v_payment := p_payment_method::public.payment_method;
  end if;

  draft := public.agent_draft_ensure(p_business_id, p_conversation_id);

  -- Solo se pisa lo que vino: el agente completa datos de a poco, a medida que
  -- el cliente los va diciendo.
  update public.whatsapp_order_drafts set
    customer_name = coalesce(nullif(trim(coalesce(p_customer_name, '')), ''), customer_name),
    order_type = coalesce(v_order_type, whatsapp_order_drafts.order_type),
    -- Pasar a retiro borra la dirección: si no, el resumen y el pedido
    -- confirmado seguían mostrando una dirección que ya no corresponde.
    delivery_address = case
      when v_order_type = 'takeaway' then null
      else coalesce(nullif(trim(coalesce(p_delivery_address, '')), ''), delivery_address)
    end,
    payment_method = coalesce(v_payment, whatsapp_order_drafts.payment_method),
    notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes)
  where id = draft.id;

  return jsonb_build_object('ok', true, 'pedido', public.agent_draft_json(p_conversation_id));
end $$;

