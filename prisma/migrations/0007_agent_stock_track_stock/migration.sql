-- ============================================================================
-- Toki — 0007_agent_stock_track_stock
-- Continuación de 0005 para las funciones del agente de WhatsApp.
--
-- `agent_draft_add_item`, `agent_order_add_draft_items`, `agent_product_detail`
-- y `agent_search_products` también daban por hecho que todo producto lleva
-- control de stock: con `track_stock = false` (y `stock_quantity` en 0) el
-- agente decía "no está disponible" y no lo podía agregar al pedido.
--
-- Ahora el agente ve exactamente lo mismo que el menú web. `agent_order_add_draft_items`
-- además deja de forzar `track_stock = true` al descontar, igual que persist_order.
-- ============================================================================

create or replace function public.agent_draft_add_item(p_business_id uuid, p_conversation_id uuid, p_product_id uuid, p_quantity integer DEFAULT 1, p_option_value_ids uuid[] DEFAULT '{}'::uuid[], p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  draft public.whatsapp_order_drafts;
  product public.products;
  option_row record;
  selected int;
  chosen jsonb := '[]'::jsonb;
  extra numeric := 0;
  unit numeric;
  ids uuid[] := coalesce(p_option_value_ids, '{}');
begin
  if not exists (select 1 from public.whatsapp_conversations
                 where id = p_conversation_id and business_id = p_business_id) then
    return jsonb_build_object('ok', false, 'error', 'Conversacion invalida.');
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > 50 then
    return jsonb_build_object('ok', false, 'error', 'La cantidad tiene que estar entre 1 y 50.');
  end if;

  select * into product
  from public.products
  where id = p_product_id and business_id = p_business_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ese producto no esta en el menu.');
  end if;
  if not product.is_available or (product.track_stock and product.stock_quantity <= 0) then
    return jsonb_build_object('ok', false, 'error', 'Ese producto no esta disponible en este momento.');
  end if;
  if product.track_stock and product.stock_quantity < p_quantity then
    return jsonb_build_object('ok', false, 'error',
      'Solo quedan ' || product.stock_quantity || ' unidades de ' || product.name || '.');
  end if;

  -- Todo value elegido tiene que pertenecer a una opcion de ESTE producto.
  if exists (
    select 1 from unnest(ids) as sel(id)
    where not exists (
      select 1
      from public.product_option_values v
      join public.product_options o on o.id = v.option_id
      where v.id = sel.id
        and o.product_id = product.id
        and v.business_id = p_business_id
        and v.is_available
        and (not v.track_stock or v.stock_quantity >= p_quantity)
    )
  ) then
    return jsonb_build_object('ok', false, 'error', 'Alguna de las opciones elegidas no existe o no esta disponible.');
  end if;

  for option_row in
    select * from public.product_options where product_id = product.id order by sort_order
  loop
    select count(*) into selected
    from public.product_option_values v
    where v.option_id = option_row.id and v.id = any(ids);

    if option_row.is_required and selected < greatest(option_row.min_select, 1) then
      return jsonb_build_object('ok', false,
        'error', 'Falta elegir ' || option_row.name || ' para ' || product.name || '.',
        'opcion_pendiente', option_row.name);
    end if;
    if selected > option_row.max_select then
      return jsonb_build_object('ok', false,
        'error', 'En ' || option_row.name || ' se puede elegir hasta ' || option_row.max_select || '.');
    end if;
  end loop;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'valueId', v.id, 'optionName', o.name, 'valueName', v.name, 'priceDelta', v.price_delta
    ) order by o.sort_order, v.sort_order), '[]'::jsonb),
    coalesce(sum(v.price_delta), 0)
  into chosen, extra
  from public.product_option_values v
  join public.product_options o on o.id = v.option_id
  where v.id = any(ids);

  draft := public.agent_draft_ensure(p_business_id, p_conversation_id);
  unit := product.price + extra;

  insert into public.whatsapp_order_draft_items (
    business_id, draft_id, product_id, product_name, quantity,
    unit_price, total_price, notes, option_value_ids, options
  ) values (
    p_business_id, draft.id, product.id, product.name, p_quantity,
    unit, unit * p_quantity, nullif(trim(coalesce(p_notes, '')), ''), ids, chosen
  );

  return jsonb_build_object('ok', true, 'pedido', public.agent_draft_json(p_conversation_id));
end $$;

create or replace function public.agent_order_add_draft_items(p_business_id uuid, p_conversation_id uuid, p_order_code text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target public.orders;
  draft public.whatsapp_order_drafts;
  item public.whatsapp_order_draft_items;
  option_item jsonb;
  new_item_id uuid;
  v_subtotal numeric;
  v_total numeric;
begin
  target := public.agent_resolve_editable_order(p_business_id, p_conversation_id, p_order_code);
  if target.id is null then
    return jsonb_build_object('ok', false, 'error', 'No encontre ese pedido.');
  end if;
  if target.status <> 'pending' or target.payment_status <> 'pending' then
    return jsonb_build_object('ok', false, 'derivar', true,
      'error', 'Ese pedido ya esta en curso o tiene un pago registrado: sumarle cosas lo tiene que hacer una persona del negocio.');
  end if;

  select * into draft
  from public.whatsapp_order_drafts
  where conversation_id = p_conversation_id and business_id = p_business_id and status = 'open';

  if not found or not exists (select 1 from public.whatsapp_order_draft_items where draft_id = draft.id) then
    return jsonb_build_object('ok', false, 'error', 'No hay productos nuevos para sumar al pedido.');
  end if;

  -- Mismo control de stock que persist_order: el borrador se armo antes y el
  -- stock pudo haberse movido entre medio.
  for item in select * from public.whatsapp_order_draft_items where draft_id = draft.id order by created_at
  loop
    if exists (
      select 1 from public.products
      where id = item.product_id and business_id = p_business_id and track_stock and stock_quantity < item.quantity
    ) then
      return jsonb_build_object('ok', false,
        'error', 'Me quede sin stock de ' || item.product_name || ' mientras armabamos el pedido.');
    end if;
  end loop;

  for item in select * from public.whatsapp_order_draft_items where draft_id = draft.id order by created_at
  loop
    update public.products
    set stock_quantity = greatest(0, stock_quantity - item.quantity),
        is_available = case when stock_quantity - item.quantity <= 0 then false else is_available end,
        updated_at = now()
    where id = item.product_id and business_id = p_business_id and track_stock;

    insert into public.order_items (business_id, order_id, product_id, product_name, quantity, unit_price, total_price, notes)
    values (p_business_id, target.id, item.product_id, item.product_name, item.quantity, item.unit_price, item.total_price, item.notes)
    returning id into new_item_id;

    for option_item in select * from jsonb_array_elements(item.options)
    loop
      update public.product_option_values
      set stock_quantity = greatest(0, stock_quantity - item.quantity),
          is_available = case when stock_quantity - item.quantity <= 0 then false else is_available end
      where id = (option_item->>'valueId')::uuid and business_id = p_business_id and track_stock;

      insert into public.order_item_options (business_id, order_item_id, option_name, value_name, price_delta)
      values (p_business_id, new_item_id, option_item->>'optionName', option_item->>'valueName', (option_item->>'priceDelta')::numeric);
    end loop;
  end loop;

  select coalesce(sum(total_price), 0) into v_subtotal
  from public.order_items where order_id = target.id;
  v_total := greatest(0, v_subtotal + target.delivery_fee - target.discount_total);

  update public.orders
  set subtotal = v_subtotal,
      total = v_total,
      whatsapp_conversation_id = coalesce(whatsapp_conversation_id, p_conversation_id),
      updated_at = now()
  where id = target.id;

  update public.payments
  set amount = v_total, updated_at = now()
  where order_id = target.id and status = 'pending';

  delete from public.whatsapp_order_draft_items where draft_id = draft.id;

  return jsonb_build_object('ok', true, 'pedido', public.agent_order_json(target.id));
end $$;

create or replace function public.agent_product_detail(p_business_id uuid, p_product_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  product public.products;
begin
  select * into product
  from public.products
  where id = p_product_id and business_id = p_business_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'No encontre ese producto en el menu.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'producto', jsonb_build_object(
      'id', product.id,
      'name', product.name,
      'description', product.description,
      'price', product.price,
      'disponible', (product.is_available and (not product.track_stock or product.stock_quantity > 0)),
      'opciones', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'name', o.name,
          'obligatoria', o.is_required,
          'elegir_minimo', o.min_select,
          'elegir_maximo', o.max_select,
          'valores', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', v.id,
              'name', v.name,
              'precio_extra', v.price_delta
            ) order by v.sort_order), '[]'::jsonb)
            from public.product_option_values v
            where v.option_id = o.id and v.is_available and (not v.track_stock or v.stock_quantity > 0)
          )
        ) order by o.sort_order), '[]'::jsonb)
        from public.product_options o where o.product_id = product.id
      )
    )
  );
end $$;

create or replace function public.agent_search_products(p_business_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 6) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  -- Tope bajo a proposito: al modelo hay que darle un puñado de opciones
  -- buenas, no el catalogo entero. Mas resultados = mas tokens y peor respuesta.
  with needle as (
    select case
      when coalesce(trim(p_query), '') = '' then null
      else '%' || replace(replace(trim(p_query), '%', '\%'), '_', '\_') || '%'
    end as pattern
  )
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  from (
    select
      p.id,
      p.name,
      p.description,
      p.price,
      c.name as category,
      -- Si tiene opciones obligatorias, el agente tiene que preguntar antes de
      -- agregarlo: se lo decimos explicitamente en vez de que lo deduzca.
      exists (
        select 1 from public.product_options o
        where o.product_id = p.id and o.is_required
      ) as requiere_opciones,
      (not p.track_stock or p.stock_quantity > 0) as con_stock
    from public.products p
    left join public.categories c on c.id = p.category_id
    cross join needle n
    where p.business_id = p_business_id
      and p.is_available
      and (not p.track_stock or p.stock_quantity > 0)
      and (
        n.pattern is null
        or p.name ilike n.pattern
        or p.description ilike n.pattern
        or c.name ilike n.pattern
      )
    order by p.is_featured desc, p.sort_order, p.name
    limit least(greatest(p_limit, 1), 12)
  ) t;
$$;
