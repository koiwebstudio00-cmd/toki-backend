-- ============================================================================
-- Toki — 0010_agente_v3_pedidos
-- Fase V3 del agente v3 (toki-agents/docs/12-plan-agente-v3.md).
--
-- 1) Stock de opciones devolvible (B16). `order_item_options` guardaba solo
--    nombres: al cancelar no había forma confiable de saber qué valor de
--    opción devolver. Se agrega `option_value_id` y lo completan
--    `persist_order` y `create_manual_sale` (idénticas a 0005 salvo eso).
-- 2) `restock_order_items`: devuelve al stock un pedido entero o parte. La usan
--    la cancelación (agente y dashboard) y la modificación (sacar o bajar
--    cantidades). Es SQL por atomicidad y porque el staff cancela pedidos pero
--    RLS no le deja tocar productos.
-- 3) `update_order_status` no deja salir de `cancelled`: reactivar un pedido
--    obligaría a volver a descontar el stock que se devolvió.
-- 4) Pedido modificado (D8): columnas de resumen en `orders` y tabla
--    `order_modifications` con el detalle de cada cambio.
-- 5) Cancelación (D9): quién, cuándo y por qué, en `orders`.
-- 6) Casos (`conversation_cases`) y reembolsos (`order_refunds`) (D9).
-- 7) `agent_order_json` devuelve el id y la nota de cada item: el agente los
--    necesita para sacar un producto o cambiarle la cantidad.
-- ============================================================================

-- ── 1. Stock de opciones ────────────────────────────────────────────────────

alter table public.order_item_options
  add column option_value_id uuid references public.product_option_values(id) on delete set null;

create or replace function public.persist_order(order_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  customer_record public.customers;
  order_record public.orders;
  item jsonb;
  option_item jsonb;
  order_item_id uuid;
  coupon_record public.coupons;
  loyalty_record public.loyalty_settings;
  discount_total numeric := coalesce((order_payload->>'discountTotal')::numeric, 0);
  points_earned int := 0;
begin
  if order_payload ? 'couponId' and nullif(order_payload->>'couponId', '') is not null then
    select * into coupon_record
    from public.coupons
    where id = (order_payload->>'couponId')::uuid
      and business_id = (order_payload->>'businessId')::uuid
    for update;
  end if;

  select * into loyalty_record
  from public.loyalty_settings
  where business_id = (order_payload->>'businessId')::uuid;

  if loyalty_record.is_enabled then
    points_earned := floor(((order_payload->>'total')::numeric) * loyalty_record.points_per_currency)::int + loyalty_record.points_per_order;
  end if;

  insert into public.customers (business_id, name, phone)
  values ((order_payload->>'businessId')::uuid, order_payload->>'customerName', order_payload->>'customerPhone')
  on conflict (business_id, phone) do update set
    name = excluded.name,
    total_spent = public.customers.total_spent + (order_payload->>'total')::numeric,
    loyalty_points = public.customers.loyalty_points + points_earned,
    updated_at = now()
  returning * into customer_record;

  if customer_record.total_spent = 0 then
    update public.customers
    set total_spent = (order_payload->>'total')::numeric,
        loyalty_points = loyalty_points + points_earned
    where id = customer_record.id
    returning * into customer_record;
  end if;

  if order_payload->>'orderType' = 'delivery' then
    insert into public.customer_addresses (business_id, customer_id, street, city)
    values ((order_payload->>'businessId')::uuid, customer_record.id, order_payload->>'deliveryAddress', order_payload->>'city');
  end if;

  insert into public.orders (
    business_id, customer_id, order_code, order_type, customer_name, customer_phone,
    delivery_address, notes, subtotal, delivery_fee, discount_total, total, payment_method, source,
    whatsapp_conversation_id,
    coupon_id, coupon_code, loyalty_points_earned, loyalty_points_redeemed
  ) values (
    (order_payload->>'businessId')::uuid, customer_record.id, order_payload->>'orderCode',
    (order_payload->>'orderType')::public.order_type, order_payload->>'customerName', order_payload->>'customerPhone',
    nullif(order_payload->>'deliveryAddress', ''), order_payload->>'notes',
    (order_payload->>'subtotal')::numeric, (order_payload->>'deliveryFee')::numeric, discount_total,
    (order_payload->>'total')::numeric, (order_payload->>'paymentMethod')::public.payment_method,
    -- El origen lo decide quien llama: 'web' desde el checkout, 'whatsapp'
    -- cuando el pedido se armo en el chat. Antes estaba fijo en 'web' y todo
    -- pedido nacia mintiendo sobre su origen.
    coalesce(nullif(order_payload->>'source', ''), 'web'),
    nullif(order_payload->>'conversationId', '')::uuid,
    coupon_record.id, nullif(order_payload->>'couponCode', ''), points_earned, 0
  ) returning * into order_record;

  if coupon_record.id is not null then
    update public.coupons set used_count = used_count + 1 where id = coupon_record.id;
  end if;

  for item in select * from jsonb_array_elements(order_payload->'items')
  loop
    if exists (
      select 1 from public.products
      where id = (item->>'productId')::uuid
        and business_id = order_record.business_id
        and track_stock
        and stock_quantity < (item->>'quantity')::int
    ) then
      raise exception 'Stock insuficiente';
    end if;

    update public.products
    set stock_quantity = greatest(0, stock_quantity - (item->>'quantity')::int),
        is_available = case
          when stock_quantity - (item->>'quantity')::int <= 0 then false
          else is_available
        end,
        updated_at = now()
    where id = (item->>'productId')::uuid
      and business_id = order_record.business_id
      and track_stock;

    insert into public.order_items (business_id, order_id, product_id, product_name, quantity, unit_price, total_price, notes)
    values (
      order_record.business_id, order_record.id, (item->>'productId')::uuid, item->>'productName',
      (item->>'quantity')::int, (item->>'unitPrice')::numeric, (item->>'totalPrice')::numeric, item->>'notes'
    ) returning id into order_item_id;

    for option_item in select * from jsonb_array_elements(coalesce(item->'options', '[]'::jsonb))
    loop
      if option_item ? 'valueId' and exists (
        select 1 from public.product_option_values
        where id = (option_item->>'valueId')::uuid
          and business_id = order_record.business_id
          and track_stock
          and stock_quantity < (item->>'quantity')::int
      ) then
        raise exception 'Stock insuficiente';
      end if;

      if option_item ? 'valueId' then
        update public.product_option_values
        set stock_quantity = greatest(0, stock_quantity - (item->>'quantity')::int),
            is_available = case
              when stock_quantity - (item->>'quantity')::int <= 0 then false
              else is_available
            end
        where id = (option_item->>'valueId')::uuid
          and business_id = order_record.business_id
          and track_stock;
      end if;

      insert into public.order_item_options (business_id, order_item_id, option_name, value_name, price_delta, option_value_id)
      values (order_record.business_id, order_item_id, option_item->>'optionName', option_item->>'valueName', (option_item->>'priceDelta')::numeric,
              nullif(option_item->>'valueId', '')::uuid);
    end loop;
  end loop;

  insert into public.order_status_history (business_id, order_id, to_status)
  values (order_record.business_id, order_record.id, 'pending');
  insert into public.payments (business_id, order_id, provider, amount)
  values (order_record.business_id, order_record.id, order_record.payment_method::text, order_record.total);

  return jsonb_build_object(
    'id', order_record.id,
    'orderCode', order_record.order_code,
    'status', order_record.status,
    'total', order_record.total,
    'discountTotal', order_record.discount_total,
    'loyaltyPointsEarned', points_earned
  );
end $$;

create or replace function public.create_manual_sale(sale_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target_business_id uuid := (sale_payload->>'businessId')::uuid;
  customer_record public.customers;
  order_record public.orders;
  product_record public.products;
  option_value_record public.product_option_values;
  item jsonb;
  option_item jsonb;
  order_item_id uuid;
  subtotal numeric := 0;
  item_total numeric;
  unit_price numeric;
  delivery_fee numeric := 0;
  discount_total numeric := coalesce((sale_payload->>'discountTotal')::numeric, 0);
  total numeric;
  item_quantity int;
  customer_name text := coalesce(nullif(trim(sale_payload->>'customerName'), ''), 'Venta mostrador');
  customer_phone text := coalesce(nullif(trim(sale_payload->>'customerPhone'), ''), 'mostrador');
  payment_method_text text := coalesce(nullif(trim(sale_payload->>'paymentMethod'), ''), 'cash');
  generated_code text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not private.is_business_member(target_business_id) then
    raise exception 'Business not found';
  end if;

  if payment_method_text not in ('cash', 'transfer') then
    raise exception 'El medio de pago no está disponible para venta presencial';
  end if;

  if discount_total < 0 then
    raise exception 'El descuento no puede ser negativo';
  end if;

  if jsonb_array_length(coalesce(sale_payload->'items', '[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  for item in select * from jsonb_array_elements(sale_payload->'items')
  loop
    item_quantity := (item->>'quantity')::int;

    select * into product_record
    from public.products
    where id = (item->>'productId')::uuid
      and business_id = target_business_id
      and is_available
    for update;

    if not found then
      raise exception 'Producto inválido';
    end if;

    if item_quantity < 1 then
      raise exception 'Cantidad inválida';
    end if;

    if product_record.track_stock and product_record.stock_quantity < item_quantity then
      raise exception 'Stock insuficiente para %', product_record.name;
    end if;

    unit_price := product_record.price;

    for option_item in select * from jsonb_array_elements(coalesce(item->'options', '[]'::jsonb))
    loop
      select pov.* into option_value_record
      from public.product_option_values pov
      join public.product_options po on po.id = pov.option_id
      where pov.id = (option_item->>'valueId')::uuid
        and pov.business_id = target_business_id
        and po.product_id = product_record.id
        and pov.is_available
      for update;

      if not found then
        raise exception 'Opción inválida';
      end if;

      if option_value_record.track_stock and option_value_record.stock_quantity < item_quantity then
        raise exception 'Stock insuficiente para %', option_value_record.name;
      end if;

      unit_price := unit_price + coalesce((option_item->>'priceDelta')::numeric, 0);
    end loop;

    item_total := unit_price * item_quantity;
    subtotal := subtotal + item_total;
  end loop;

  if discount_total > subtotal then
    raise exception 'El descuento no puede superar el subtotal';
  end if;

  total := subtotal + delivery_fee - discount_total;

  if customer_phone <> 'mostrador' then
    insert into public.customers (business_id, name, phone, total_spent)
    values (target_business_id, customer_name, customer_phone, total)
    on conflict (business_id, phone) do update set
      name = excluded.name,
      total_spent = public.customers.total_spent + total,
      updated_at = now()
    returning * into customer_record;
  end if;

  generated_code := 'TK-' || lpad((floor(random() * 900000)::int + 100000)::text, 6, '0');
  while exists (select 1 from public.orders where order_code = generated_code) loop
    generated_code := 'TK-' || lpad((floor(random() * 900000)::int + 100000)::text, 6, '0');
  end loop;

  insert into public.orders (
    business_id, customer_id, order_code, status, order_type, customer_name, customer_phone,
    subtotal, delivery_fee, discount_total, total, payment_method, payment_status, source, notes
  ) values (
    target_business_id, customer_record.id, generated_code, 'delivered', 'takeaway', customer_name, customer_phone,
    subtotal, delivery_fee, discount_total, total, payment_method_text::public.payment_method, 'paid', 'manual', sale_payload->>'notes'
  ) returning * into order_record;

  for item in select * from jsonb_array_elements(sale_payload->'items')
  loop
    item_quantity := (item->>'quantity')::int;

    select * into product_record
    from public.products
    where id = (item->>'productId')::uuid
      and business_id = target_business_id
    for update;

    unit_price := product_record.price;

    update public.products
    set stock_quantity = greatest(0, stock_quantity - item_quantity),
        is_available = case
          when stock_quantity - item_quantity <= 0 then false
          else is_available
        end,
        updated_at = now()
    where id = product_record.id
      and business_id = target_business_id
      and track_stock;

    for option_item in select * from jsonb_array_elements(coalesce(item->'options', '[]'::jsonb))
    loop
      unit_price := unit_price + coalesce((option_item->>'priceDelta')::numeric, 0);

      update public.product_option_values
      set stock_quantity = greatest(0, stock_quantity - item_quantity),
          is_available = case
            when stock_quantity - item_quantity <= 0 then false
            else is_available
          end
      where id = (option_item->>'valueId')::uuid
        and business_id = target_business_id
        and track_stock;
    end loop;

    item_total := unit_price * item_quantity;

    insert into public.order_items (business_id, order_id, product_id, product_name, quantity, unit_price, total_price, notes)
    values (
      target_business_id, order_record.id, product_record.id, product_record.name,
      item_quantity, unit_price, item_total, item->>'notes'
    ) returning id into order_item_id;

    for option_item in select * from jsonb_array_elements(coalesce(item->'options', '[]'::jsonb))
    loop
      insert into public.order_item_options (business_id, order_item_id, option_name, value_name, price_delta, option_value_id)
      values (
        target_business_id,
        order_item_id,
        option_item->>'optionName',
        option_item->>'valueName',
        coalesce((option_item->>'priceDelta')::numeric, 0),
        nullif(option_item->>'valueId', '')::uuid
      );
    end loop;
  end loop;

  insert into public.order_status_history (business_id, order_id, to_status, changed_by, note)
  values (target_business_id, order_record.id, 'delivered', auth.uid(), 'Venta presencial');

  insert into public.payments (business_id, order_id, provider, status, amount)
  values (target_business_id, order_record.id, order_record.payment_method::text, 'paid', order_record.total);

  return jsonb_build_object(
    'id', order_record.id,
    'orderCode', order_record.order_code,
    'total', order_record.total,
    'status', order_record.status
  );
end $$;

-- ── 2. Devolución de stock ──────────────────────────────────────────────────

-- p_items null: el pedido entero. Si no: [{ "orderItemId": uuid, "quantity": int }]
-- con la cantidad a devolver de cada item. Solo suma donde `track_stock` está
-- activo. Si el producto o valor estaba pausado porque se había quedado sin
-- stock (en 0), lo vuelve a habilitar; si lo pausaron a mano con stock, no.
create or replace function public.restock_order_items(p_order_id uuid, p_items jsonb default null) returns void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target public.orders;
  item record;
  qty int;
  opt record;
  value_id uuid;
begin
  select * into target from public.orders where id = p_order_id;
  if not found then
    raise exception 'Pedido no encontrado';
  end if;
  -- Desde el panel (hay usuario) tiene que ser miembro del negocio. Sin usuario
  -- es la API con service_role, que ya validó el negocio.
  if auth.uid() is not null and not private.is_business_member(target.business_id) then
    raise exception 'Pedido no encontrado';
  end if;

  for item in
    select i.id, i.product_id, i.quantity
    from public.order_items i
    where i.order_id = p_order_id
  loop
    if p_items is null then
      qty := item.quantity;
    else
      select coalesce(sum((e->>'quantity')::int), 0) into qty
      from jsonb_array_elements(p_items) e
      where (e->>'orderItemId')::uuid = item.id;
    end if;
    continue when qty is null or qty <= 0;

    if item.product_id is not null then
      update public.products
      set is_available = case when stock_quantity <= 0 then true else is_available end,
          stock_quantity = stock_quantity + qty,
          updated_at = now()
      where id = item.product_id and business_id = target.business_id and track_stock;
    end if;

    for opt in
      select o.option_value_id, o.option_name, o.value_name
      from public.order_item_options o
      where o.order_item_id = item.id
    loop
      value_id := opt.option_value_id;
      -- Pedidos anteriores a esta migración: se busca el valor por nombre.
      if value_id is null and item.product_id is not null then
        select v.id into value_id
        from public.product_option_values v
        join public.product_options po on po.id = v.option_id
        where po.product_id = item.product_id and po.name = opt.option_name and v.name = opt.value_name
        limit 1;
      end if;
      if value_id is not null then
        update public.product_option_values
        set is_available = case when stock_quantity <= 0 then true else is_available end,
            stock_quantity = stock_quantity + qty,
            updated_at = now()
        where id = value_id and business_id = target.business_id and track_stock;
      end if;
    end loop;
  end loop;
end $$;

revoke all on function public.restock_order_items(uuid, jsonb) from public;
grant execute on function public.restock_order_items(uuid, jsonb) to authenticated, service_role;

-- ── 3. No reactivar pedidos cancelados ──────────────────────────────────────

create or replace function public.update_order_status(target_order_id uuid, new_status public.order_status, status_note text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare current_order public.orders;
begin
  select * into current_order from public.orders where id = target_order_id for update;
  if current_order.id is null or not private.is_business_member(current_order.business_id) then raise exception 'Order not found'; end if;
  if current_order.status = 'cancelled' and new_status <> 'cancelled' then
    raise exception 'Un pedido cancelado no se puede reactivar.';
  end if;
  update public.orders set status = new_status, updated_at = now() where id = target_order_id;
  insert into public.order_status_history (business_id, order_id, from_status, to_status, changed_by, note)
  values (current_order.business_id, target_order_id, current_order.status, new_status, auth.uid(), status_note);
end $$;

-- ── 4 y 5. Resumen en orders ────────────────────────────────────────────────

alter table public.orders
  add column modified_at timestamptz,
  add column modification_count integer not null default 0,
  add column last_modified_during public.order_status,
  add column modification_seen_at timestamptz,
  add column cancelled_at timestamptz,
  add column cancelled_by text,
  add column cancellation_reason text,
  add constraint orders_modification_count_check check (modification_count >= 0),
  add constraint orders_cancelled_by_check check (cancelled_by is null or cancelled_by in ('customer_whatsapp', 'business_dashboard'));

create table public.order_modifications (
  id uuid default gen_random_uuid() not null primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  source text not null,
  conversation_id uuid references public.whatsapp_conversations(id) on delete set null,
  status_at_change public.order_status not null,
  changes jsonb not null default '{}'::jsonb,
  subtotal_before numeric(12,2) not null,
  total_before numeric(12,2) not null,
  total_after numeric(12,2) not null,
  created_at timestamptz not null default now(),
  constraint order_modifications_source_check check (source in ('whatsapp', 'dashboard'))
);
create index order_modifications_order_idx on public.order_modifications (order_id, created_at);
create index order_modifications_business_idx on public.order_modifications (business_id, created_at);

alter table public.order_modifications enable row level security;
create policy "members read order_modifications" on public.order_modifications
  for select to authenticated using (private.is_business_member(business_id));
grant select on public.order_modifications to authenticated;
grant all on public.order_modifications to service_role;

-- ── 6. Casos y reembolsos ───────────────────────────────────────────────────

create table public.conversation_cases (
  id uuid default gen_random_uuid() not null primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  reason text not null,
  summary text,
  status text not null default 'open',
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolution_note text,
  constraint conversation_cases_reason_check check (reason in ('cancelacion', 'reembolso', 'cambio_pedido', 'queja', 'pedido_humano', 'no_puedo_ayudar')),
  constraint conversation_cases_status_check check (status in ('open', 'resolved'))
);
create index conversation_cases_business_idx on public.conversation_cases (business_id, opened_at);
create index conversation_cases_conversation_idx on public.conversation_cases (conversation_id, opened_at);

alter table public.conversation_cases enable row level security;
create policy "members read conversation_cases" on public.conversation_cases
  for select to authenticated using (private.is_business_member(business_id));
create policy "members resolve conversation_cases" on public.conversation_cases
  for update to authenticated using (private.is_business_member(business_id)) with check (private.is_business_member(business_id));
grant select, update on public.conversation_cases to authenticated;
grant all on public.conversation_cases to service_role;

alter table public.whatsapp_conversations
  add column current_case_id uuid references public.conversation_cases(id) on delete set null;

create table public.order_refunds (
  id uuid default gen_random_uuid() not null primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  case_id uuid references public.conversation_cases(id) on delete set null,
  conversation_id uuid references public.whatsapp_conversations(id) on delete set null,
  amount numeric(12,2) not null,
  reason text not null,
  original_payment_method public.payment_method not null,
  destination jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references public.profiles(id) on delete set null,
  proof_storage_path text,
  notes text,
  constraint order_refunds_amount_check check (amount > 0),
  constraint order_refunds_reason_check check (reason in ('cancelacion', 'modificacion_baja_total', 'otro')),
  constraint order_refunds_status_check check (status in ('pending', 'completed', 'rejected'))
);
create index order_refunds_business_idx on public.order_refunds (business_id, status, requested_at);
create index order_refunds_order_idx on public.order_refunds (order_id);

alter table public.order_refunds enable row level security;
create policy "members read order_refunds" on public.order_refunds
  for select to authenticated using (private.is_business_member(business_id));
create policy "members update order_refunds" on public.order_refunds
  for update to authenticated using (private.is_business_member(business_id)) with check (private.is_business_member(business_id));
grant select, update on public.order_refunds to authenticated;
grant all on public.order_refunds to service_role;

-- ── 7. Items con id en agent_order_json ────────────────────────────────────

create or replace function public.agent_order_json(p_order_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'id', o.id,
    'order_code', o.order_code,
    'status', o.status,
    'order_type', o.order_type,
    'delivery_address', o.delivery_address,
    'customer_name', o.customer_name,
    'payment_method', o.payment_method,
    'payment_status', o.payment_status,
    'subtotal', o.subtotal,
    'delivery_fee', o.delivery_fee,
    'discount_total', o.discount_total,
    'total', o.total,
    'created_at', o.created_at,
    -- Solo se puede tocar mientras el negocio no lo confirmo y no hay pago
    -- registrado. Lo decide el servidor, no el modelo.
    'editable', (o.status = 'pending' and o.payment_status = 'pending'),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        -- v3: el id del item para sacarlo o cambiarle la cantidad, y su nota.
        'id', i.id,
        'notes', i.notes,
        'product_name', i.product_name,
        'quantity', i.quantity,
        'total_price', i.total_price,
        'options', (
          select coalesce(jsonb_agg(jsonb_build_object('option_name', op.option_name, 'value_name', op.value_name)), '[]'::jsonb)
          from public.order_item_options op where op.order_item_id = i.id
        )
      ) order by i.id), '[]'::jsonb)
      from public.order_items i where i.order_id = o.id
    )
  )
  from public.orders o
  where o.id = p_order_id;
$$;
