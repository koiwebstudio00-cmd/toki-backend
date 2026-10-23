-- Quantities are kilograms for kg products, integers for unit products.
alter table public.products add column sale_unit text not null default 'unit' check (sale_unit in ('unit','kg'));
alter table public.products alter column stock_quantity type numeric(12,3), alter column low_stock_threshold type numeric(12,3);
alter table public.products add constraint products_unit_stock_integral check (sale_unit <> 'unit' or (stock_quantity = trunc(stock_quantity) and low_stock_threshold = trunc(low_stock_threshold)));
alter table public.order_items alter column quantity type numeric(12,3);
alter table public.order_items add column sale_unit text not null default 'unit' check (sale_unit in ('unit','kg')), add column calculated_total numeric(12,2), add column manual_adjustment numeric(12,2) not null default 0;
update public.order_items set calculated_total = total_price;
alter table public.order_items add constraint order_item_adjustment_consistent check (sale_unit = 'unit' or calculated_total is null or total_price = calculated_total + manual_adjustment);
-- Existing tenant policies remain in force; no new exposed table.
-- Preserve stock, pricing, authorization and payment in the existing sale transaction.
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
  item_quantity numeric;
  calculated_total numeric;
  option_group record;
  selected_count integer;
  customer_name text := coalesce(nullif(trim(sale_payload->>'customerName'), ''), 'Venta mostrador');
  customer_phone text := coalesce(nullif(trim(sale_payload->>'customerPhone'), ''), 'mostrador');
  payment_method_text text := coalesce(nullif(trim(sale_payload->>'paymentMethod'), ''), 'cash');
  generated_code text;
  fulfillment_text text := coalesce(sale_payload->>'fulfillment', 'immediate');
  initial_status public.order_status;
  payment_timing text := coalesce(sale_payload->>'paymentTiming', 'now');
  initial_payment_status public.payment_status;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not private.is_business_member(target_business_id) then
    raise exception 'Business not found';
  end if;

  if fulfillment_text not in ('immediate', 'kitchen') then
    raise exception 'Elegí entregar ahora o enviar a cocina';
  end if;
  initial_status := case when fulfillment_text = 'kitchen' then 'confirmed'::public.order_status else 'delivered'::public.order_status end;

  if payment_method_text not in ('cash', 'transfer') then
    raise exception 'El medio de pago no está disponible para venta presencial';
  end if;

  if payment_timing not in ('now', 'pickup') or (payment_timing = 'pickup' and (fulfillment_text <> 'kitchen' or payment_method_text <> 'cash')) then
    raise exception 'El pago al retirar requiere enviar a cocina y pagar en efectivo';
  end if;
  initial_payment_status := case when payment_timing = 'pickup' then 'pending'::public.payment_status else 'paid'::public.payment_status end;

  if discount_total < 0 then
    raise exception 'El descuento no puede ser negativo';
  end if;

  if jsonb_array_length(coalesce(sale_payload->'items', '[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  for item in select * from jsonb_array_elements(sale_payload->'items')
  loop
    item_quantity := (item->>'quantity')::numeric;

    select * into product_record
    from public.products
    where id = (item->>'productId')::uuid
      and business_id = target_business_id
      and is_available
    for update;

    if not found then
      raise exception 'Producto inválido';
    end if;

    if item_quantity is null or item_quantity <= 0 or item_quantity > 500 or item_quantity <> round(item_quantity, 3) or (product_record.sale_unit = 'unit' and item_quantity <> trunc(item_quantity)) then
      raise exception 'Cantidad inválida';
    end if;

    if product_record.track_stock and product_record.stock_quantity < item_quantity then
      raise exception 'Stock insuficiente para %', product_record.name;
    end if;

    if product_record.sale_unit = 'kg' and jsonb_array_length(coalesce(item->'options','[]'::jsonb)) > 0 then raise exception 'Los agregados se configuran en productos por unidad'; end if;
    if product_record.sale_unit <> 'kg' and item->>'finalAmount' is not null then raise exception 'El ajuste manual es exclusivo de productos por peso'; end if;
    if (select count(*) <> count(distinct e->>'valueId') from jsonb_array_elements(coalesce(item->'options','[]'::jsonb)) e) then raise exception 'Hay opciones repetidas'; end if;
    for option_group in select * from public.product_options where product_id = product_record.id and business_id = target_business_id loop
      select count(*) into selected_count from jsonb_array_elements(coalesce(item->'options','[]'::jsonb)) e join public.product_option_values v on v.id = (e->>'valueId')::uuid where v.option_id = option_group.id and v.is_available;
      if selected_count < greatest(option_group.min_select, case when option_group.is_required then 1 else 0 end) or selected_count > option_group.max_select then raise exception 'Revisá las opciones de %', product_record.name; end if;
    end loop;
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

      unit_price := unit_price + option_value_record.price_delta;
    end loop;

    calculated_total := round(unit_price * item_quantity, 2);
    item_total := coalesce((item->>'finalAmount')::numeric, calculated_total);
    if item_total < 0 or item_total > 999999999 or item_total <> round(item_total, 2) or item_total::text in ('NaN','Infinity','-Infinity') then raise exception 'Importe final inválido'; end if;
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
    target_business_id, customer_record.id, generated_code, initial_status, 'takeaway', customer_name, customer_phone,
    subtotal, delivery_fee, discount_total, total, payment_method_text::public.payment_method, initial_payment_status, 'manual', sale_payload->>'notes'
  ) returning * into order_record;

  for item in select * from jsonb_array_elements(sale_payload->'items')
  loop
    item_quantity := (item->>'quantity')::numeric;

    select * into product_record
    from public.products
    where id = (item->>'productId')::uuid
      and business_id = target_business_id
    for update;

    unit_price := product_record.price;

    if product_record.track_stock and product_record.stock_quantity < item_quantity then raise exception 'Stock insuficiente para %', product_record.name; end if;
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
      select * into option_value_record from public.product_option_values where id = (option_item->>'valueId')::uuid and business_id = target_business_id for update;
      if option_value_record.track_stock and option_value_record.stock_quantity < item_quantity then raise exception 'Stock insuficiente para %', option_value_record.name; end if;
      unit_price := unit_price + option_value_record.price_delta;

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

    calculated_total := round(unit_price * item_quantity, 2);
    item_total := coalesce((item->>'finalAmount')::numeric, calculated_total);
    if item_total < 0 or item_total > 999999999 or item_total <> round(item_total, 2) or item_total::text in ('NaN','Infinity','-Infinity') then raise exception 'Importe final inválido'; end if;

    insert into public.order_items (business_id, order_id, product_id, product_name, quantity, unit_price, total_price, notes, sale_unit, calculated_total, manual_adjustment)
    values (
      target_business_id, order_record.id, product_record.id, product_record.name,
      item_quantity, unit_price, item_total, item->>'notes', product_record.sale_unit, calculated_total, item_total - calculated_total
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
  values (target_business_id, order_record.id, initial_status, auth.uid(), case when fulfillment_text = 'kitchen' then 'Venta presencial para cocina' else 'Venta presencial' end);

  insert into public.payments (business_id, order_id, provider, status, amount)
  values (target_business_id, order_record.id, order_record.payment_method::text, initial_payment_status, order_record.total);

  return jsonb_build_object(
    'id', order_record.id,
    'orderCode', order_record.order_code,
    'total', order_record.total,
    'status', order_record.status
  );
end $$;

create or replace function public.restock_order_items(p_order_id uuid, p_items jsonb default null) returns void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target public.orders;
  item record;
  qty numeric;
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
      select coalesce(sum((e->>'quantity')::numeric), 0) into qty
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

-- Guard every persistence path, including legacy SQL agent functions.
create function public.guard_weighted_order_item() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.products p join public.orders o on o.id = new.order_id and o.business_id = p.business_id where p.id = new.product_id and p.sale_unit = 'kg' and o.source <> 'manual') then
    raise exception 'Los productos por peso se venden únicamente en el local';
  end if;
  return new;
end $$;
create trigger guard_weighted_order_item before insert or update of product_id on public.order_items for each row execute function public.guard_weighted_order_item();
