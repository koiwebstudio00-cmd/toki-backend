-- ============================================================================
-- Toki — 0005_stock_respeta_track_stock
--
-- Bug heredado: `persist_order` y `create_manual_sale` comparaban el stock
-- SIEMPRE, aunque el producto o el valor de opción tuviera `track_stock = false`
-- (y `stock_quantity` en 0, que es el default de la tabla). Resultado: cualquier
-- producto para el que el negocio decidió NO llevar stock quedaba imposible de
-- vender, con el mensaje "Stock insuficiente".
--
-- Además, las dos funciones ponían `track_stock = true` al descontar: bastaba
-- una venta para que un producto sin control de stock empezara a controlarlo y
-- se pausara solo al llegar a cero.
--
-- Acá el stock se valida y se descuenta únicamente cuando `track_stock` está
-- activo. Para todo lo que ya lleva stock (todo lo cargado desde el panel, que
-- siempre lo activa) el comportamiento es idéntico.
-- ============================================================================

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

      insert into public.order_item_options (business_id, order_item_id, option_name, value_name, price_delta)
      values (order_record.business_id, order_item_id, option_item->>'optionName', option_item->>'valueName', (option_item->>'priceDelta')::numeric);
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
      insert into public.order_item_options (business_id, order_item_id, option_name, value_name, price_delta)
      values (
        target_business_id,
        order_item_id,
        option_item->>'optionName',
        option_item->>'valueName',
        coalesce((option_item->>'priceDelta')::numeric, 0)
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
