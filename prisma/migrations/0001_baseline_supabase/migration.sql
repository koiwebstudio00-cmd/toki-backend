-- ============================================================================
-- Toki — 0001_baseline_supabase
--
-- Réplica del schema productivo de Supabase (27 migraciones de toki/supabase/
-- migrations, estado al 2026-09-17), consolidada en un solo archivo para
-- PostgreSQL 17 autogestionado.
--
-- Diferencias con Supabase (a propósito):
--   * auth.users es la tabla de usuarios propia (email + password_hash).
--     Mantiene el id de Supabase para migrar datos sin tocar FKs.
--   * auth.uid() lee request.jwt.claim.sub / request.jwt.claims, igual que
--     Supabase. La API los setea por transacción (ver docs/arquitectura.md §5).
--   * Roles anon / authenticated / service_role: se conservan con el mismo
--     nombre para que las 60 policies y las funciones SQL funcionen sin cambios.
--   * Sin schema storage (archivos en R2) ni publicación supabase_realtime
--     (realtime por LISTEN/NOTIFY, migración 0003).
--   * No incluye 20260702233435_optimize_inventory_ingredient_policies: sus
--     policies ya estaban en 20260702232816 (el archivo local tiene deriva).
--
-- Regla: NO editar. Cambios nuevos = migración nueva (prisma migrate dev --create-only).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

--
-- PostgreSQL database dump
--

\restrict ay1PbtMMcxiHu7B874RerX4VPVcfnPXVA1PQJOTVsD0ePbJSirsiZBegFkd0ZDv


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: extensions; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA extensions;


--
-- Name: private; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA private;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: business_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.business_role AS ENUM (
    'owner',
    'admin',
    'staff'
);


--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'pending',
    'confirmed',
    'preparing',
    'ready',
    'out_for_delivery',
    'delivered',
    'cancelled'
);


--
-- Name: order_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_type AS ENUM (
    'delivery',
    'takeaway'
);


--
-- Name: payment_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_method AS ENUM (
    'cash',
    'transfer',
    'mercadopago'
);


--
-- Name: payment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status AS ENUM (
    'pending',
    'paid',
    'failed',
    'refunded'
);


--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;


--
-- Name: has_business_role(uuid, public.business_role[]); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.has_business_role(target_business_id uuid, allowed_roles public.business_role[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ select exists (select 1 from public.business_members where business_id = target_business_id and user_id = (select auth.uid()) and role = any(allowed_roles)) $$;


--
-- Name: is_business_member(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.is_business_member(target_business_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ select exists (select 1 from public.business_members where business_id = target_business_id and user_id = (select auth.uid())) $$;


--
-- Name: agent_context(uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_context(p_business_id uuid, p_conversation_id uuid, p_k integer DEFAULT 12) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  business public.businesses;
  conversation public.whatsapp_conversations;
  pay public.payment_settings;
  bot public.bot_settings;
  active_order_id uuid;
begin
  select * into business from public.businesses where id = p_business_id;
  if not found then
    return jsonb_build_object('error', 'business_not_found');
  end if;

  select * into conversation
  from public.whatsapp_conversations
  where id = p_conversation_id and business_id = p_business_id;

  select * into pay from public.payment_settings where business_id = p_business_id;
  select * into bot from public.bot_settings where business_id = p_business_id;

  -- Pedido "vivo" del contacto: el que el cliente va a mencionar si pregunta
  -- algo. Se busca primero por la conversacion y despues por telefono, para
  -- que un pedido hecho en la web tambien aparezca.
  select o.id into active_order_id
  from public.orders o
  where o.business_id = p_business_id
    and o.status not in ('delivered', 'cancelled')
    and (
      o.whatsapp_conversation_id = p_conversation_id
      or (conversation.phone is not null and o.customer_phone = conversation.phone)
    )
  order by o.created_at desc
  limit 1;

  return jsonb_build_object(
    'business', jsonb_build_object(
      'id', business.id,
      'name', business.name,
      'slug', business.slug,
      'address', business.address,
      'city', business.city,
      'currency', business.currency,
      'delivery_fee', business.delivery_fee,
      'minimum_order_amount', business.minimum_order_amount,
      'estimated_delivery_minutes', business.estimated_delivery_minutes,
      'is_open', public.business_is_open(p_business_id)
    ),
    'hours', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'day_of_week', h.day_of_week,
        'is_open', h.is_open,
        'opens_at', h.opens_at,
        'closes_at', h.closes_at,
        'opens_at_2', h.opens_at_2,
        'closes_at_2', h.closes_at_2
      ) order by h.day_of_week), '[]'::jsonb)
      from public.business_hours h where h.business_id = p_business_id
    ),
    'special_hours', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', s.date, 'is_closed', s.is_closed,
        'opens_at', s.opens_at, 'closes_at', s.closes_at, 'note', s.note
      ) order by s.date), '[]'::jsonb)
      from public.business_special_hours s
      where s.business_id = p_business_id
        and s.date between current_date and current_date + 7
    ),
    'payment', jsonb_build_object(
      'cash_enabled', coalesce(pay.cash_enabled, true),
      'transfer_enabled', coalesce(pay.transfer_enabled, true),
      'mercadopago_enabled', coalesce(pay.mercadopago_enabled, false),
      'transfer_alias', pay.transfer_alias,
      'transfer_cbu', pay.transfer_cbu,
      'transfer_holder', pay.transfer_holder,
      'transfer_bank', pay.transfer_bank
    ),
    'bot', jsonb_build_object(
      'is_enabled', coalesce(bot.is_enabled, true),
      'bot_name', coalesce(bot.bot_name, 'Toki'),
      'tone', coalesce(bot.tone, 'friendly'),
      'fallback_message', coalesce(bot.fallback_message, 'Te derivo con una persona del equipo para que pueda ayudarte.'),
      'handoff_enabled', coalesce(bot.handoff_enabled, true)
    ),
    'faqs', (
      select coalesce(jsonb_agg(jsonb_build_object('question', f.question, 'answer', f.answer)), '[]'::jsonb)
      from public.bot_faqs f where f.business_id = p_business_id and f.is_active
    ),
    'featured_products', (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'price', p.price) order by p.sort_order), '[]'::jsonb)
      from public.products p
      where p.business_id = p_business_id and p.is_featured and p.is_available
      limit 6
    ),
    'conversation', jsonb_build_object(
      'id', conversation.id,
      'status', conversation.status,
      'contact_id', conversation.contact_id,
      'phone', conversation.phone
    ),
    -- Los ultimos k, pero devueltos en orden cronologico: el modelo lee la
    -- conversacion como la leeria una persona.
    'messages', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'direction', t.direction,
        'content', t.content,
        'message_type', t.message_type,
        'created_at', t.created_at
      ) order by t.created_at), '[]'::jsonb)
      from (
        select mm.direction, mm.content, mm.message_type, mm.created_at
        from public.whatsapp_messages mm
        where mm.conversation_id = p_conversation_id
        order by mm.created_at desc
        limit greatest(p_k, 1)
      ) t
    ),
    'draft', public.agent_draft_json(p_conversation_id),
    'active_order', case when active_order_id is null then null else public.agent_order_json(active_order_id) end
  );
end $$;


--
-- Name: agent_conversation_handoff(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_conversation_handoff(p_business_id uuid, p_conversation_id uuid, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  reason text := coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'no_puedo_ayudar');
begin
  if reason not in ('pedido_humano', 'queja', 'cancelacion', 'cambio_pedido', 'no_puedo_ayudar') then
    reason := 'no_puedo_ayudar';
  end if;

  update public.whatsapp_conversations
  set status = 'handoff',
      handoff_reason = reason,
      updated_at = now()
  where id = p_conversation_id and business_id = p_business_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Conversacion invalida.');
  end if;
  return jsonb_build_object('ok', true, 'motivo', reason);
end $$;


--
-- Name: agent_draft_add_item(uuid, uuid, uuid, integer, uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_draft_add_item(p_business_id uuid, p_conversation_id uuid, p_product_id uuid, p_quantity integer DEFAULT 1, p_option_value_ids uuid[] DEFAULT '{}'::uuid[], p_notes text DEFAULT NULL::text) RETURNS jsonb
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
  if not product.is_available or product.stock_quantity <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Ese producto no esta disponible en este momento.');
  end if;
  if product.stock_quantity < p_quantity then
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
        and v.stock_quantity >= p_quantity
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


--
-- Name: agent_draft_cancel(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_draft_cancel(p_business_id uuid, p_conversation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  update public.whatsapp_order_drafts
  set status = 'cancelled'
  where conversation_id = p_conversation_id
    and business_id = p_business_id
    and status = 'open';
  return jsonb_build_object('ok', true);
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: whatsapp_order_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_order_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    customer_name text,
    order_type public.order_type,
    delivery_address text,
    payment_method public.payment_method,
    notes text,
    order_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_order_drafts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'confirmed'::text, 'cancelled'::text])))
);


--
-- Name: agent_draft_ensure(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_draft_ensure(p_business_id uuid, p_conversation_id uuid) RETURNS public.whatsapp_order_drafts
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  draft public.whatsapp_order_drafts;
begin
  select * into draft
  from public.whatsapp_order_drafts
  where conversation_id = p_conversation_id and status = 'open';

  if found then
    return draft;
  end if;

  -- Una conversacion tiene un solo borrador (constraint unica). Si el anterior
  -- quedo confirmado o cancelado, se recicla la fila en vez de chocar.
  insert into public.whatsapp_order_drafts (business_id, conversation_id)
  values (p_business_id, p_conversation_id)
  on conflict (conversation_id) do update
    set status = 'open',
        order_id = null,
        customer_name = null,
        order_type = null,
        delivery_address = null,
        payment_method = null,
        notes = null,
        updated_at = now()
  returning * into draft;

  delete from public.whatsapp_order_draft_items where draft_id = draft.id;
  return draft;
end $$;


--
-- Name: agent_draft_get(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_draft_get(p_business_id uuid, p_conversation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  draft jsonb;
begin
  if not exists (select 1 from public.whatsapp_conversations
                 where id = p_conversation_id and business_id = p_business_id) then
    return jsonb_build_object('ok', false, 'error', 'Conversacion invalida.');
  end if;
  draft := public.agent_draft_json(p_conversation_id);
  if draft is null then
    return jsonb_build_object('ok', true, 'pedido', null, 'error', 'Todavia no hay nada en el pedido.');
  end if;
  return jsonb_build_object('ok', true, 'pedido', draft);
end $$;


--
-- Name: agent_draft_json(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_draft_json(p_conversation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  draft public.whatsapp_order_drafts;
  business public.businesses;
  items jsonb;
  subtotal numeric := 0;
  delivery_fee numeric := 0;
  missing text[] := '{}';
begin
  select * into draft
  from public.whatsapp_order_drafts
  where conversation_id = p_conversation_id and status = 'open';

  if not found then
    return null;
  end if;

  select * into business from public.businesses where id = draft.business_id;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id,
      'product_id', i.product_id,
      'product_name', i.product_name,
      'quantity', i.quantity,
      'unit_price', i.unit_price,
      'total_price', i.total_price,
      'notes', i.notes,
      'options', i.options
    ) order by i.created_at), '[]'::jsonb),
    coalesce(sum(i.total_price), 0)
  into items, subtotal
  from public.whatsapp_order_draft_items i
  where i.draft_id = draft.id;

  if draft.order_type = 'delivery' then
    delivery_fee := business.delivery_fee;
  end if;

  -- Que falta para poder confirmar. Lo resuelve el servidor para que el modelo
  -- no tenga que deducirlo ni se olvide de preguntar algo.
  if jsonb_array_length(items) = 0 then missing := array_append(missing, 'productos'); end if;
  if coalesce(trim(draft.customer_name), '') = '' then missing := array_append(missing, 'nombre'); end if;
  if draft.order_type is null then missing := array_append(missing, 'entrega_o_retiro'); end if;
  if draft.order_type = 'delivery' and coalesce(trim(draft.delivery_address), '') = '' then
    missing := array_append(missing, 'direccion');
  end if;
  if draft.payment_method is null then missing := array_append(missing, 'metodo_de_pago'); end if;
  if subtotal < business.minimum_order_amount then missing := array_append(missing, 'pedido_minimo'); end if;

  return jsonb_build_object(
    'id', draft.id,
    'status', draft.status,
    'customer_name', draft.customer_name,
    'order_type', draft.order_type,
    'delivery_address', draft.delivery_address,
    'payment_method', draft.payment_method,
    'notes', draft.notes,
    'items', items,
    'subtotal', subtotal,
    'delivery_fee', delivery_fee,
    'total', subtotal + delivery_fee,
    'minimum_order_amount', business.minimum_order_amount,
    'currency', business.currency,
    'falta', to_jsonb(missing),
    'listo_para_confirmar', (array_length(missing, 1) is null)
  );
end $$;


--
-- Name: agent_draft_remove_item(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_draft_remove_item(p_business_id uuid, p_conversation_id uuid, p_item_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  removed int;
begin
  delete from public.whatsapp_order_draft_items i
  using public.whatsapp_order_drafts d
  where i.draft_id = d.id
    and i.id = p_item_id
    and d.conversation_id = p_conversation_id
    and d.business_id = p_business_id
    and d.status = 'open';
  get diagnostics removed = row_count;

  if removed = 0 then
    return jsonb_build_object('ok', false, 'error', 'Ese item ya no esta en el pedido.');
  end if;
  return jsonb_build_object('ok', true, 'pedido', public.agent_draft_json(p_conversation_id));
end $$;


--
-- Name: agent_draft_set_details(uuid, uuid, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_draft_set_details(p_business_id uuid, p_conversation_id uuid, p_customer_name text DEFAULT NULL::text, p_order_type text DEFAULT NULL::text, p_delivery_address text DEFAULT NULL::text, p_payment_method text DEFAULT NULL::text, p_notes text DEFAULT NULL::text) RETURNS jsonb
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
    delivery_address = coalesce(nullif(trim(coalesce(p_delivery_address, '')), ''), delivery_address),
    payment_method = coalesce(v_payment, whatsapp_order_drafts.payment_method),
    notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes)
  where id = draft.id;

  return jsonb_build_object('ok', true, 'pedido', public.agent_draft_json(p_conversation_id));
end $$;


--
-- Name: agent_order_add_draft_items(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_order_add_draft_items(p_business_id uuid, p_conversation_id uuid, p_order_code text DEFAULT NULL::text) RETURNS jsonb
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
      where id = item.product_id and business_id = p_business_id and stock_quantity < item.quantity
    ) then
      return jsonb_build_object('ok', false,
        'error', 'Me quede sin stock de ' || item.product_name || ' mientras armabamos el pedido.');
    end if;
  end loop;

  for item in select * from public.whatsapp_order_draft_items where draft_id = draft.id order by created_at
  loop
    update public.products
    set stock_quantity = greatest(0, stock_quantity - item.quantity),
        track_stock = true,
        is_available = case when stock_quantity - item.quantity <= 0 then false else is_available end,
        updated_at = now()
    where id = item.product_id and business_id = p_business_id;

    insert into public.order_items (business_id, order_id, product_id, product_name, quantity, unit_price, total_price, notes)
    values (p_business_id, target.id, item.product_id, item.product_name, item.quantity, item.unit_price, item.total_price, item.notes)
    returning id into new_item_id;

    for option_item in select * from jsonb_array_elements(item.options)
    loop
      update public.product_option_values
      set stock_quantity = greatest(0, stock_quantity - item.quantity),
          track_stock = true,
          is_available = case when stock_quantity - item.quantity <= 0 then false else is_available end
      where id = (option_item->>'valueId')::uuid and business_id = p_business_id;

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


--
-- Name: agent_order_json(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_order_json(p_order_id uuid) RETURNS jsonb
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


--
-- Name: agent_order_status(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_order_status(p_business_id uuid, p_conversation_id uuid, p_order_code text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  code text := upper(coalesce(substring(coalesce(p_order_code, '') from 'TK-[0-9]{6}'), ''));
  conversation public.whatsapp_conversations;
  found_id uuid;
begin
  select * into conversation
  from public.whatsapp_conversations
  where id = p_conversation_id and business_id = p_business_id;

  if code <> '' then
    -- El codigo siempre se valida contra el negocio del canal: un TK- de otro
    -- local no puede leerse desde aca.
    select o.id into found_id
    from public.orders o
    where o.business_id = p_business_id and o.order_code = code;
  else
    select o.id into found_id
    from public.orders o
    where o.business_id = p_business_id
      and (
        o.whatsapp_conversation_id = p_conversation_id
        or (conversation.phone is not null and o.customer_phone = conversation.phone)
      )
    order by o.created_at desc
    limit 1;
  end if;

  if found_id is null then
    return jsonb_build_object('ok', false, 'error', 'No encontre ningun pedido con esos datos.');
  end if;

  return jsonb_build_object('ok', true, 'pedido', public.agent_order_json(found_id));
end $$;


--
-- Name: agent_order_update_details(uuid, uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_order_update_details(p_business_id uuid, p_conversation_id uuid, p_order_code text DEFAULT NULL::text, p_order_type text DEFAULT NULL::text, p_delivery_address text DEFAULT NULL::text, p_payment_method text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target public.orders;
  business public.businesses;
  pay public.payment_settings;
  v_order_type public.order_type;
  v_payment public.payment_method;
  v_address text;
  v_fee numeric;
  v_total numeric;
begin
  target := public.agent_resolve_editable_order(p_business_id, p_conversation_id, p_order_code);
  if target.id is null then
    return jsonb_build_object('ok', false, 'error', 'No encontre ese pedido.');
  end if;
  if target.status <> 'pending' or target.payment_status <> 'pending' then
    return jsonb_build_object('ok', false, 'derivar', true,
      'error', 'Ese pedido ya esta en curso o tiene un pago registrado: los cambios los tiene que hacer una persona del negocio.');
  end if;

  select * into business from public.businesses where id = p_business_id;

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

  v_order_type := coalesce(v_order_type, target.order_type);
  v_address := coalesce(nullif(trim(coalesce(p_delivery_address, '')), ''), target.delivery_address);
  if v_order_type = 'delivery' and coalesce(trim(coalesce(v_address, '')), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Para delivery necesito la direccion de entrega.');
  end if;

  -- El envio se recalcula: pasar de retiro a delivery cambia el total.
  v_fee := case when v_order_type = 'delivery' then business.delivery_fee else 0 end;
  v_total := greatest(0, target.subtotal + v_fee - target.discount_total);

  update public.orders set
    order_type = v_order_type,
    delivery_address = case when v_order_type = 'delivery' then v_address else null end,
    payment_method = coalesce(v_payment, payment_method),
    delivery_fee = v_fee,
    total = v_total,
    whatsapp_conversation_id = coalesce(whatsapp_conversation_id, p_conversation_id),
    updated_at = now()
  where id = target.id;

  -- El registro de pago sigue al total mientras no se haya cobrado.
  update public.payments
  set amount = v_total,
      provider = coalesce(v_payment::text, provider),
      updated_at = now()
  where order_id = target.id and status = 'pending';

  return jsonb_build_object('ok', true, 'pedido', public.agent_order_json(target.id));
end $$;


--
-- Name: agent_product_detail(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_product_detail(p_business_id uuid, p_product_id uuid) RETURNS jsonb
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
      'disponible', (product.is_available and product.stock_quantity > 0),
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
            where v.option_id = o.id and v.is_available and v.stock_quantity > 0
          )
        ) order by o.sort_order), '[]'::jsonb)
        from public.product_options o where o.product_id = product.id
      )
    )
  );
end $$;


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    customer_id uuid,
    order_code text NOT NULL,
    status public.order_status DEFAULT 'pending'::public.order_status NOT NULL,
    order_type public.order_type DEFAULT 'delivery'::public.order_type NOT NULL,
    customer_name text NOT NULL,
    customer_phone text NOT NULL,
    delivery_address text,
    delivery_notes text,
    notes text,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    delivery_fee numeric(12,2) DEFAULT 0 NOT NULL,
    discount_total numeric(12,2) DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    payment_method public.payment_method DEFAULT 'cash'::public.payment_method NOT NULL,
    payment_status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    source text DEFAULT 'web'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    coupon_id uuid,
    coupon_code text,
    loyalty_points_earned integer DEFAULT 0 NOT NULL,
    loyalty_points_redeemed integer DEFAULT 0 NOT NULL,
    whatsapp_conversation_id uuid,
    CONSTRAINT orders_check CHECK (((order_type <> 'delivery'::public.order_type) OR (delivery_address IS NOT NULL))),
    CONSTRAINT orders_loyalty_points_earned_check CHECK ((loyalty_points_earned >= 0)),
    CONSTRAINT orders_loyalty_points_redeemed_check CHECK ((loyalty_points_redeemed >= 0)),
    CONSTRAINT orders_order_code_check CHECK ((order_code ~ '^TK-[0-9]{6}$'::text)),
    CONSTRAINT orders_source_check CHECK ((source = ANY (ARRAY['web'::text, 'whatsapp'::text, 'manual'::text])))
);


--
-- Name: agent_resolve_editable_order(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_resolve_editable_order(p_business_id uuid, p_conversation_id uuid, p_order_code text) RETURNS public.orders
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  code text := upper(coalesce(substring(coalesce(p_order_code, '') from 'TK-[0-9]{6}'), ''));
  conversation public.whatsapp_conversations;
  result public.orders;
begin
  select * into conversation
  from public.whatsapp_conversations
  where id = p_conversation_id and business_id = p_business_id;

  if code <> '' then
    select * into result from public.orders
    where business_id = p_business_id and order_code = code;
  else
    select * into result from public.orders o
    where o.business_id = p_business_id
      and o.status not in ('delivered', 'cancelled')
      and (
        o.whatsapp_conversation_id = p_conversation_id
        or (conversation.phone is not null and o.customer_phone = conversation.phone)
      )
    order by o.created_at desc
    limit 1;
  end if;

  return result;
end $$;


--
-- Name: agent_search_faq(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_search_faq(p_business_id uuid, p_query text, p_limit integer DEFAULT 3) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  with needle as (
    select '%' || replace(replace(coalesce(trim(p_query), ''), '%', '\%'), '_', '\_') || '%' as pattern
  )
  select coalesce(jsonb_agg(jsonb_build_object('question', f.question, 'answer', f.answer)), '[]'::jsonb)
  from (
    select f.question, f.answer
    from public.bot_faqs f
    cross join needle n
    where f.business_id = p_business_id
      and f.is_active
      and (f.question ilike n.pattern or f.answer ilike n.pattern)
    limit least(greatest(p_limit, 1), 5)
  ) f;
$$;


--
-- Name: agent_search_products(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_search_products(p_business_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 6) RETURNS jsonb
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
      (p.stock_quantity > 0) as con_stock
    from public.products p
    left join public.categories c on c.id = p.category_id
    cross join needle n
    where p.business_id = p_business_id
      and p.is_available
      and p.stock_quantity > 0
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


--
-- Name: business_is_open(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.business_is_open(p_business_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  business public.businesses;
  zone text;
  local_now timestamp;
  local_date date;
  local_time time;
begin
  select * into business from public.businesses where id = p_business_id;
  if not found or not business.is_active then
    return false;
  end if;
  if business.manual_status = 'open' then return true; end if;
  if business.manual_status = 'closed' then return false; end if;

  zone := coalesce(nullif(business.timezone, ''), 'America/Argentina/Buenos_Aires');
  local_now := (now() at time zone zone);
  local_date := local_now::date;
  local_time := local_now::time;

  if exists (
    select 1 from public.business_schedule_windows(p_business_id, local_date) w
    where (w.closes_at >= w.opens_at and local_time >= w.opens_at and local_time <= w.closes_at)
       or (w.closes_at < w.opens_at and local_time >= w.opens_at)
  ) then
    return true;
  end if;

  -- Ventana de ayer que cruza la medianoche (cierra a las 02:00).
  return exists (
    select 1 from public.business_schedule_windows(p_business_id, local_date - 1) w
    where w.closes_at < w.opens_at and local_time <= w.closes_at
  );
end $$;


--
-- Name: business_schedule_windows(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.business_schedule_windows(p_business_id uuid, p_date date) RETURNS TABLE(opens_at time without time zone, closes_at time without time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  special public.business_special_hours;
  regular public.business_hours;
begin
  -- Un feriado o dia especial reemplaza al horario semanal, no se suma.
  select * into special
  from public.business_special_hours
  where business_id = p_business_id and date = p_date;

  if found then
    if special.is_closed or special.opens_at is null or special.closes_at is null then
      return;
    end if;
    opens_at := special.opens_at;
    closes_at := special.closes_at;
    return next;
    return;
  end if;

  select * into regular
  from public.business_hours
  where business_id = p_business_id
    and day_of_week = extract(dow from p_date)::int;

  if not found or not regular.is_open or regular.opens_at is null or regular.closes_at is null then
    return;
  end if;

  opens_at := regular.opens_at;
  closes_at := regular.closes_at;
  return next;

  -- Segundo turno (cortan al mediodia): migracion 20260702232816.
  if regular.opens_at_2 is not null and regular.closes_at_2 is not null then
    opens_at := regular.opens_at_2;
    closes_at := regular.closes_at_2;
    return next;
  end if;
end $$;


--
-- Name: create_business_with_owner(text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_business_with_owner(business_name text, business_slug text, business_phone text, business_address text, business_city text, business_description text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare new_business_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.businesses (
    name,
    slug,
    whatsapp_phone,
    address,
    city,
    description,
    logo_url,
    cover_url
  )
  values (
    business_name,
    business_slug,
    business_phone,
    business_address,
    business_city,
    business_description,
    '/defaults/toki-default-logo.jpeg',
    '/defaults/toki-default-banner.png'
  )
  returning id into new_business_id;
  insert into public.business_members (business_id, user_id, role) values (new_business_id, auth.uid(), 'owner');
  insert into public.bot_settings (business_id) values (new_business_id);
  insert into public.business_hours (business_id, day_of_week, is_open, opens_at, closes_at)
  select new_business_id, day, true, '19:00'::time, '23:30'::time from generate_series(0, 6) day;
  return new_business_id;
end $$;


--
-- Name: create_manual_sale(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_manual_sale(sale_payload jsonb) RETURNS jsonb
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

    if product_record.stock_quantity < item_quantity then
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

      if option_value_record.stock_quantity < item_quantity then
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
        track_stock = true,
        is_available = case
          when stock_quantity - item_quantity <= 0 then false
          else is_available
        end,
        updated_at = now()
    where id = product_record.id
      and business_id = target_business_id;

    for option_item in select * from jsonb_array_elements(coalesce(item->'options', '[]'::jsonb))
    loop
      unit_price := unit_price + coalesce((option_item->>'priceDelta')::numeric, 0);

      update public.product_option_values
      set stock_quantity = greatest(0, stock_quantity - item_quantity),
          track_stock = true,
          is_available = case
            when stock_quantity - item_quantity <= 0 then false
            else is_available
          end
      where id = (option_item->>'valueId')::uuid
        and business_id = target_business_id;
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


--
-- Name: get_public_order(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_public_order(target_order_code text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'id', o.id,
    'business_id', o.business_id,
    'business_name', b.name,
    'business_slug', b.slug,
    'order_code', o.order_code,
    'status', o.status,
    'order_type', o.order_type,
    'customer_name', o.customer_name,
    'delivery_address', o.delivery_address,
    'subtotal', o.subtotal,
    'delivery_fee', o.delivery_fee,
    'discount_total', o.discount_total,
    'total', o.total,
    'coupon_code', o.coupon_code,
    'payment_method', o.payment_method,
    'payment_status', o.payment_status,
    'source', o.source,
    'created_at', o.created_at,
    'order_items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'product_name', i.product_name,
        'quantity', i.quantity,
        'unit_price', i.unit_price,
        'total_price', i.total_price,
        'order_item_options', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', opt.id,
            'option_name', opt.option_name,
            'value_name', opt.value_name,
            'price_delta', opt.price_delta
          ))
          from public.order_item_options opt
          where opt.order_item_id = i.id
        ), '[]'::jsonb)
      ) order by i.created_at, i.id)
      from public.order_items i
      where i.order_id = o.id
    ), '[]'::jsonb),
    'order_status_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'from_status', h.from_status,
        'to_status', h.to_status,
        'note', h.note,
        'created_at', h.created_at
      ) order by h.created_at)
      from public.order_status_history h
      where h.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  join public.businesses b on b.id = o.business_id
  where o.order_code = target_order_code
    and b.is_active;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ begin insert into public.profiles (id, full_name) values (new.id, new.raw_user_meta_data ->> 'full_name'); return new; end $$;


--
-- Name: mark_order_paid(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_order_paid(target_order_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  current_order public.orders;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into current_order
  from public.orders
  where id = target_order_id
  for update;

  if current_order.id is null or not private.is_business_member(current_order.business_id) then
    raise exception 'Order not found';
  end if;

  update public.orders
  set payment_status = 'paid',
      updated_at = now()
  where id = target_order_id
    and business_id = current_order.business_id;

  update public.payments
  set status = 'paid',
      updated_at = now()
  where order_id = target_order_id
    and business_id = current_order.business_id;

  if not found then
    insert into public.payments (business_id, order_id, provider, status, amount)
    values (current_order.business_id, current_order.id, current_order.payment_method::text, 'paid', current_order.total);
  end if;
end $$;


--
-- Name: persist_order(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.persist_order(order_payload jsonb) RETURNS jsonb
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
        and stock_quantity < (item->>'quantity')::int
    ) then
      raise exception 'Stock insuficiente';
    end if;

    update public.products
    set stock_quantity = greatest(0, stock_quantity - (item->>'quantity')::int),
        track_stock = true,
        is_available = case
          when stock_quantity - (item->>'quantity')::int <= 0 then false
          else is_available
        end,
        updated_at = now()
    where id = (item->>'productId')::uuid
      and business_id = order_record.business_id;

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
          and stock_quantity < (item->>'quantity')::int
      ) then
        raise exception 'Stock insuficiente';
      end if;

      if option_item ? 'valueId' then
        update public.product_option_values
        set stock_quantity = greatest(0, stock_quantity - (item->>'quantity')::int),
            track_stock = true,
            is_available = case
              when stock_quantity - (item->>'quantity')::int <= 0 then false
              else is_available
            end
        where id = (option_item->>'valueId')::uuid
          and business_id = order_record.business_id;
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


--
-- Name: search_dashboard(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_dashboard(target_business_id uuid, search_term text) RETURNS TABLE(result_id uuid, result_group text, title text, detail text, href text, rank numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $_$
  with normalized as (
    select trim(search_term) as term
  ),
  product_results as (
    select
      p.id as result_id,
      'Productos'::text as result_group,
      p.name as title,
      '$ ' || trim(to_char(p.price, 'FM999G999G999G990')) || ' · ' || p.barcode as detail,
      '/dashboard/products'::text as href,
      greatest(
        extensions.similarity(extensions.unaccent(lower(p.name)), extensions.unaccent(lower(n.term))),
        extensions.similarity(lower(p.barcode), lower(n.term))
      )::numeric as rank
    from public.products p
    cross join normalized n
    where p.business_id = target_business_id
      and length(n.term) >= 2
      and (
        extensions.unaccent(lower(p.name)) like '%' || extensions.unaccent(lower(n.term)) || '%'
        or lower(p.barcode) like '%' || lower(n.term) || '%'
        or extensions.similarity(extensions.unaccent(lower(p.name)), extensions.unaccent(lower(n.term))) > 0.22
      )
    order by rank desc, p.name
    limit 5
  ),
  customer_results as (
    select
      c.id as result_id,
      'Clientes'::text as result_group,
      c.name as title,
      coalesce(nullif(c.phone, ''), 'Cliente') as detail,
      '/dashboard/customers'::text as href,
      greatest(
        extensions.similarity(extensions.unaccent(lower(c.name)), extensions.unaccent(lower(n.term))),
        extensions.similarity(lower(coalesce(c.phone, '')), lower(n.term))
      )::numeric as rank
    from public.customers c
    cross join normalized n
    where c.business_id = target_business_id
      and length(n.term) >= 2
      and (
        extensions.unaccent(lower(c.name)) like '%' || extensions.unaccent(lower(n.term)) || '%'
        or lower(coalesce(c.phone, '')) like '%' || lower(n.term) || '%'
        or extensions.similarity(extensions.unaccent(lower(c.name)), extensions.unaccent(lower(n.term))) > 0.22
      )
    order by rank desc, c.name
    limit 5
  ),
  order_results as (
    select
      o.id as result_id,
      'Pedidos'::text as result_group,
      o.customer_name as title,
      o.order_code || ' · $ ' || trim(to_char(o.total, 'FM999G999G999G990')) || ' · ' || o.status::text as detail,
      '/dashboard/orders'::text as href,
      extensions.similarity(extensions.unaccent(lower(o.customer_name)), extensions.unaccent(lower(n.term)))::numeric as rank
    from public.orders o
    cross join normalized n
    where o.business_id = target_business_id
      and length(n.term) >= 2
      and (
        extensions.unaccent(lower(o.customer_name)) like '%' || extensions.unaccent(lower(n.term)) || '%'
        or extensions.similarity(extensions.unaccent(lower(o.customer_name)), extensions.unaccent(lower(n.term))) > 0.22
      )
    order by rank desc, o.created_at desc
    limit 5
  )
  select * from product_results
  union all
  select * from customer_results
  union all
  select * from order_results;
$_$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$ begin new.updated_at = now(); return new; end $$;


--
-- Name: update_order_status(uuid, public.order_status, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_order_status(target_order_id uuid, new_status public.order_status, status_note text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare current_order public.orders;
begin
  select * into current_order from public.orders where id = target_order_id for update;
  if current_order.id is null or not private.is_business_member(current_order.business_id) then raise exception 'Order not found'; end if;
  update public.orders set status = new_status, updated_at = now() where id = target_order_id;
  insert into public.order_status_history (business_id, order_id, from_status, to_status, changed_by, note)
  values (current_order.business_id, target_order_id, current_order.status, new_status, auth.uid(), status_note);
end $$;


--
-- Name: users; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email extensions.citext NOT NULL,
    password_hash text NOT NULL,
    email_verified_at timestamp with time zone,
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bot_faqs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_faqs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bot_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    bot_name text DEFAULT 'Toki'::text NOT NULL,
    tone text DEFAULT 'friendly'::text NOT NULL,
    fallback_message text DEFAULT 'Te derivo con una persona del equipo para que pueda ayudarte.'::text NOT NULL,
    handoff_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: business_hours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_hours (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    day_of_week integer NOT NULL,
    is_open boolean DEFAULT true NOT NULL,
    opens_at time without time zone,
    closes_at time without time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    opens_at_2 time without time zone,
    closes_at_2 time without time zone,
    CONSTRAINT business_hours_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6))),
    CONSTRAINT business_hours_second_shift_complete CHECK (((opens_at_2 IS NULL) = (closes_at_2 IS NULL)))
);


--
-- Name: business_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.business_role DEFAULT 'owner'::public.business_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: business_special_hours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_special_hours (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    date date NOT NULL,
    is_closed boolean DEFAULT true NOT NULL,
    opens_at time without time zone,
    closes_at time without time zone,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_special_hours_check CHECK ((is_closed OR ((opens_at IS NOT NULL) AND (closes_at IS NOT NULL))))
);


--
-- Name: businesses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.businesses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    business_type text,
    logo_url text,
    cover_url text,
    phone text,
    whatsapp_phone text,
    address text,
    city text,
    country text DEFAULT 'Argentina'::text NOT NULL,
    currency text DEFAULT 'ARS'::text NOT NULL,
    timezone text DEFAULT 'America/Argentina/Buenos_Aires'::text NOT NULL,
    estimated_delivery_minutes integer DEFAULT 45 NOT NULL,
    minimum_order_amount numeric(12,2) DEFAULT 0 NOT NULL,
    delivery_fee numeric(12,2) DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    manual_status text DEFAULT 'auto'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT businesses_delivery_fee_check CHECK ((delivery_fee >= (0)::numeric)),
    CONSTRAINT businesses_estimated_delivery_minutes_check CHECK ((estimated_delivery_minutes > 0)),
    CONSTRAINT businesses_manual_status_check CHECK ((manual_status = ANY (ARRAY['auto'::text, 'open'::text, 'closed'::text]))),
    CONSTRAINT businesses_minimum_order_amount_check CHECK ((minimum_order_amount >= (0)::numeric)),
    CONSTRAINT businesses_slug_check CHECK ((slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text))
);


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    image_url text
);


--
-- Name: coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    code text NOT NULL,
    description text,
    discount_type text NOT NULL,
    discount_value numeric(12,2) NOT NULL,
    minimum_order_amount numeric(12,2) DEFAULT 0 NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    usage_limit integer,
    used_count integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupons_discount_type_check CHECK ((discount_type = ANY (ARRAY['percent'::text, 'fixed'::text]))),
    CONSTRAINT coupons_discount_value_check CHECK ((discount_value > (0)::numeric)),
    CONSTRAINT coupons_minimum_order_amount_check CHECK ((minimum_order_amount >= (0)::numeric)),
    CONSTRAINT coupons_usage_limit_check CHECK (((usage_limit IS NULL) OR (usage_limit > 0))),
    CONSTRAINT coupons_used_count_check CHECK ((used_count >= 0))
);


--
-- Name: customer_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    label text DEFAULT 'Principal'::text NOT NULL,
    street text NOT NULL,
    details text,
    city text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    loyalty_points integer DEFAULT 0 NOT NULL,
    total_spent numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT customers_loyalty_points_check CHECK ((loyalty_points >= 0)),
    CONSTRAINT customers_total_spent_check CHECK ((total_spent >= (0)::numeric))
);


--
-- Name: inventory_ingredients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_ingredients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    quantity numeric(12,3) DEFAULT 0 NOT NULL,
    unit text DEFAULT 'kg'::text NOT NULL,
    low_stock_threshold numeric(12,3) DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inventory_ingredients_low_stock_threshold_check CHECK ((low_stock_threshold >= (0)::numeric)),
    CONSTRAINT inventory_ingredients_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT inventory_ingredients_quantity_check CHECK ((quantity >= (0)::numeric)),
    CONSTRAINT inventory_ingredients_unit_check CHECK ((unit = ANY (ARRAY['kg'::text, 'g'::text, 'l'::text, 'ml'::text, 'unit'::text])))
);


--
-- Name: loyalty_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loyalty_settings (
    business_id uuid NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    points_per_currency numeric(12,4) DEFAULT 0.01 NOT NULL,
    points_per_order integer DEFAULT 0 NOT NULL,
    redeem_rate numeric(12,2) DEFAULT 10 NOT NULL,
    min_points_to_redeem integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT loyalty_settings_min_points_to_redeem_check CHECK ((min_points_to_redeem >= 0)),
    CONSTRAINT loyalty_settings_points_per_currency_check CHECK ((points_per_currency >= (0)::numeric)),
    CONSTRAINT loyalty_settings_points_per_order_check CHECK ((points_per_order >= 0)),
    CONSTRAINT loyalty_settings_redeem_rate_check CHECK ((redeem_rate > (0)::numeric))
);


--
-- Name: order_item_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    option_name text NOT NULL,
    value_name text NOT NULL,
    price_delta numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    order_id uuid NOT NULL,
    product_id uuid,
    product_name text NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    total_price numeric(12,2) NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT order_items_total_price_check CHECK ((total_price >= (0)::numeric)),
    CONSTRAINT order_items_unit_price_check CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: order_payment_proofs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_payment_proofs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    order_id uuid NOT NULL,
    conversation_id uuid,
    storage_path text NOT NULL,
    media_type text DEFAULT 'image'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_payment_proofs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: order_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    order_id uuid NOT NULL,
    from_status public.order_status,
    to_status public.order_status NOT NULL,
    changed_by uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_settings (
    business_id uuid NOT NULL,
    cash_enabled boolean DEFAULT true NOT NULL,
    transfer_enabled boolean DEFAULT true NOT NULL,
    transfer_cbu text,
    transfer_alias text,
    transfer_holder text,
    mercadopago_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    transfer_bank text,
    CONSTRAINT payment_settings_transfer_alias_check CHECK (((transfer_alias IS NULL) OR (length(TRIM(BOTH FROM transfer_alias)) <= 80))),
    CONSTRAINT payment_settings_transfer_bank_check CHECK (((transfer_bank IS NULL) OR (length(TRIM(BOTH FROM transfer_bank)) <= 120))),
    CONSTRAINT payment_settings_transfer_cbu_check CHECK (((transfer_cbu IS NULL) OR ((length(TRIM(BOTH FROM transfer_cbu)) >= 6) AND (length(TRIM(BOTH FROM transfer_cbu)) <= 40)))),
    CONSTRAINT payment_settings_transfer_holder_check CHECK (((transfer_holder IS NULL) OR (length(TRIM(BOTH FROM transfer_holder)) <= 120)))
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    order_id uuid NOT NULL,
    provider text DEFAULT 'manual'::text NOT NULL,
    status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    amount numeric(12,2) NOT NULL,
    external_payment_id text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payments_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT payments_provider_check CHECK ((provider = ANY (ARRAY['cash'::text, 'transfer'::text, 'mercadopago'::text, 'manual'::text])))
);


--
-- Name: product_option_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_option_values (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    option_id uuid NOT NULL,
    name text NOT NULL,
    price_delta numeric(12,2) DEFAULT 0 NOT NULL,
    is_available boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    track_stock boolean DEFAULT false NOT NULL,
    stock_quantity integer DEFAULT 0 NOT NULL,
    low_stock_threshold integer DEFAULT 5 NOT NULL,
    CONSTRAINT product_option_values_low_stock_threshold_check CHECK ((low_stock_threshold >= 0)),
    CONSTRAINT product_option_values_stock_quantity_check CHECK ((stock_quantity >= 0))
);


--
-- Name: product_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    product_id uuid NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'single'::text NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    min_select integer DEFAULT 0 NOT NULL,
    max_select integer DEFAULT 1 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_options_check CHECK (((max_select >= 1) AND (max_select >= min_select))),
    CONSTRAINT product_options_min_select_check CHECK ((min_select >= 0)),
    CONSTRAINT product_options_type_check CHECK ((type = ANY (ARRAY['single'::text, 'multiple'::text])))
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    category_id uuid,
    name text NOT NULL,
    description text,
    price numeric(12,2) NOT NULL,
    image_url text,
    is_available boolean DEFAULT true NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    preparation_minutes integer,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    barcode text DEFAULT ('TKI-'::text || upper(substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 10))) NOT NULL,
    track_stock boolean DEFAULT false NOT NULL,
    stock_quantity integer DEFAULT 0 NOT NULL,
    low_stock_threshold integer DEFAULT 5 NOT NULL,
    CONSTRAINT products_barcode_not_blank CHECK (((length(TRIM(BOTH FROM barcode)) >= 4) AND (length(TRIM(BOTH FROM barcode)) <= 64))),
    CONSTRAINT products_low_stock_threshold_check CHECK ((low_stock_threshold >= 0)),
    CONSTRAINT products_preparation_minutes_check CHECK (((preparation_minutes IS NULL) OR (preparation_minutes > 0))),
    CONSTRAINT products_price_check CHECK ((price >= (0)::numeric)),
    CONSTRAINT products_stock_quantity_check CHECK ((stock_quantity >= 0))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    full_name text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    phone text,
    CONSTRAINT profiles_phone_length CHECK (((phone IS NULL) OR (length(TRIM(BOTH FROM phone)) <= 40)))
);


--
-- Name: whatsapp_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    customer_id uuid,
    phone text,
    status text DEFAULT 'open'::text NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_id text NOT NULL,
    handoff_reason text,
    CONSTRAINT whatsapp_conversations_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'handoff'::text])))
);


--
-- Name: COLUMN whatsapp_conversations.contact_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.whatsapp_conversations.contact_id IS 'Identidad del contacto en el canal: telefono sin + cuando esta disponible, businessScopedUserId si el usuario escribe sin exponer numero.';


--
-- Name: whatsapp_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    phone_number text,
    phone_number_id text,
    waba_id text,
    access_token_encrypted text,
    verify_token text,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text DEFAULT 'meta'::text NOT NULL,
    provider_external_id text,
    provider_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT whatsapp_integrations_provider_check CHECK ((provider = ANY (ARRAY['meta'::text, 'zernio'::text])))
);


--
-- Name: whatsapp_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    direction text NOT NULL,
    message_type text DEFAULT 'text'::text NOT NULL,
    content text,
    raw_payload jsonb,
    ai_intent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_message_id text,
    CONSTRAINT whatsapp_messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
    CONSTRAINT whatsapp_messages_message_type_check CHECK ((message_type = ANY (ARRAY['text'::text, 'image'::text, 'audio'::text, 'document'::text, 'unknown'::text])))
);


--
-- Name: COLUMN whatsapp_messages.provider_message_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.whatsapp_messages.provider_message_id IS 'Id del evento/mensaje en el proveedor (Zernio). Unico por negocio: es la guarda de idempotencia del webhook.';


--
-- Name: whatsapp_order_draft_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_order_draft_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    total_price numeric(12,2) NOT NULL,
    notes text,
    option_value_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_order_draft_items_quantity_check CHECK (((quantity >= 1) AND (quantity <= 50))),
    CONSTRAINT whatsapp_order_draft_items_total_price_check CHECK ((total_price >= (0)::numeric)),
    CONSTRAINT whatsapp_order_draft_items_unit_price_check CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: bot_faqs bot_faqs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_faqs
    ADD CONSTRAINT bot_faqs_pkey PRIMARY KEY (id);


--
-- Name: bot_settings bot_settings_business_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_settings
    ADD CONSTRAINT bot_settings_business_id_key UNIQUE (business_id);


--
-- Name: bot_settings bot_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_settings
    ADD CONSTRAINT bot_settings_pkey PRIMARY KEY (id);


--
-- Name: business_hours business_hours_business_id_day_of_week_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_hours
    ADD CONSTRAINT business_hours_business_id_day_of_week_key UNIQUE (business_id, day_of_week);


--
-- Name: business_hours business_hours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_hours
    ADD CONSTRAINT business_hours_pkey PRIMARY KEY (id);


--
-- Name: business_members business_members_business_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_members
    ADD CONSTRAINT business_members_business_id_user_id_key UNIQUE (business_id, user_id);


--
-- Name: business_members business_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_members
    ADD CONSTRAINT business_members_pkey PRIMARY KEY (id);


--
-- Name: business_special_hours business_special_hours_business_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_special_hours
    ADD CONSTRAINT business_special_hours_business_id_date_key UNIQUE (business_id, date);


--
-- Name: business_special_hours business_special_hours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_special_hours
    ADD CONSTRAINT business_special_hours_pkey PRIMARY KEY (id);


--
-- Name: businesses businesses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_pkey PRIMARY KEY (id);


--
-- Name: businesses businesses_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_slug_key UNIQUE (slug);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: coupons coupons_business_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_business_id_code_key UNIQUE (business_id, code);


--
-- Name: coupons coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);


--
-- Name: customer_addresses customer_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_pkey PRIMARY KEY (id);


--
-- Name: customers customers_business_id_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_business_id_phone_key UNIQUE (business_id, phone);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: inventory_ingredients inventory_ingredients_business_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_ingredients
    ADD CONSTRAINT inventory_ingredients_business_id_name_key UNIQUE (business_id, name);


--
-- Name: inventory_ingredients inventory_ingredients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_ingredients
    ADD CONSTRAINT inventory_ingredients_pkey PRIMARY KEY (id);


--
-- Name: loyalty_settings loyalty_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_settings
    ADD CONSTRAINT loyalty_settings_pkey PRIMARY KEY (business_id);


--
-- Name: order_item_options order_item_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_options
    ADD CONSTRAINT order_item_options_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: order_payment_proofs order_payment_proofs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_payment_proofs
    ADD CONSTRAINT order_payment_proofs_pkey PRIMARY KEY (id);


--
-- Name: order_status_history order_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT order_status_history_pkey PRIMARY KEY (id);


--
-- Name: orders orders_order_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_order_code_key UNIQUE (order_code);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: payment_settings payment_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settings
    ADD CONSTRAINT payment_settings_pkey PRIMARY KEY (business_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: product_option_values product_option_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_option_values
    ADD CONSTRAINT product_option_values_pkey PRIMARY KEY (id);


--
-- Name: product_options product_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_options
    ADD CONSTRAINT product_options_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_conversations whatsapp_conversations_business_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversations
    ADD CONSTRAINT whatsapp_conversations_business_id_contact_id_key UNIQUE (business_id, contact_id);


--
-- Name: whatsapp_conversations whatsapp_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversations
    ADD CONSTRAINT whatsapp_conversations_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_integrations whatsapp_integrations_business_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_integrations
    ADD CONSTRAINT whatsapp_integrations_business_id_key UNIQUE (business_id);


--
-- Name: whatsapp_integrations whatsapp_integrations_phone_number_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_integrations
    ADD CONSTRAINT whatsapp_integrations_phone_number_id_key UNIQUE (phone_number_id);


--
-- Name: whatsapp_integrations whatsapp_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_integrations
    ADD CONSTRAINT whatsapp_integrations_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_messages whatsapp_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_order_draft_items whatsapp_order_draft_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_draft_items
    ADD CONSTRAINT whatsapp_order_draft_items_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_order_drafts whatsapp_order_drafts_conversation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_drafts
    ADD CONSTRAINT whatsapp_order_drafts_conversation_id_key UNIQUE (conversation_id);


--
-- Name: whatsapp_order_drafts whatsapp_order_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_drafts
    ADD CONSTRAINT whatsapp_order_drafts_pkey PRIMARY KEY (id);


--
-- Name: idx_business_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_members_user_id ON public.business_members USING btree (user_id);


--
-- Name: idx_businesses_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_businesses_slug ON public.businesses USING btree (slug);


--
-- Name: idx_categories_business_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_business_id ON public.categories USING btree (business_id);


--
-- Name: idx_coupons_business_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupons_business_code ON public.coupons USING btree (business_id, code);


--
-- Name: idx_customers_business_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_business_phone ON public.customers USING btree (business_id, phone);


--
-- Name: idx_inventory_ingredients_business_stock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_ingredients_business_stock ON public.inventory_ingredients USING btree (business_id, quantity, low_stock_threshold);


--
-- Name: idx_option_values_low_stock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_option_values_low_stock ON public.product_option_values USING btree (business_id, track_stock, stock_quantity);


--
-- Name: idx_option_values_option_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_option_values_option_id ON public.product_option_values USING btree (option_id);


--
-- Name: idx_order_history_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_history_order_id ON public.order_status_history USING btree (order_id, created_at);


--
-- Name: idx_order_items_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_order_id ON public.order_items USING btree (order_id);


--
-- Name: idx_order_payment_proofs_business_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_payment_proofs_business_id ON public.order_payment_proofs USING btree (business_id);


--
-- Name: idx_order_payment_proofs_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_payment_proofs_order_id ON public.order_payment_proofs USING btree (order_id, created_at);


--
-- Name: idx_orders_business_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_business_created ON public.orders USING btree (business_id, created_at DESC);


--
-- Name: idx_orders_business_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_business_status ON public.orders USING btree (business_id, status);


--
-- Name: idx_orders_coupon_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_coupon_id ON public.orders USING btree (coupon_id);


--
-- Name: idx_orders_order_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_order_code ON public.orders USING btree (order_code);


--
-- Name: idx_orders_whatsapp_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_whatsapp_conversation_id ON public.orders USING btree (whatsapp_conversation_id);


--
-- Name: idx_product_options_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_options_product_id ON public.product_options USING btree (product_id);


--
-- Name: idx_products_business_barcode; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_products_business_barcode ON public.products USING btree (business_id, barcode);


--
-- Name: idx_products_business_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_business_id ON public.products USING btree (business_id);


--
-- Name: idx_products_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_category_id ON public.products USING btree (category_id);


--
-- Name: idx_products_low_stock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_low_stock ON public.products USING btree (business_id, track_stock, stock_quantity);


--
-- Name: idx_special_hours_business_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_special_hours_business_date ON public.business_special_hours USING btree (business_id, date);


--
-- Name: idx_whatsapp_conversations_business_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_conversations_business_phone ON public.whatsapp_conversations USING btree (business_id, phone);


--
-- Name: idx_whatsapp_integrations_provider_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_whatsapp_integrations_provider_external_id ON public.whatsapp_integrations USING btree (provider, provider_external_id) WHERE (provider_external_id IS NOT NULL);


--
-- Name: idx_whatsapp_messages_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_messages_conversation_id ON public.whatsapp_messages USING btree (conversation_id, created_at);


--
-- Name: idx_whatsapp_order_draft_items_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_order_draft_items_draft_id ON public.whatsapp_order_draft_items USING btree (draft_id, created_at);


--
-- Name: uq_whatsapp_messages_provider_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_whatsapp_messages_provider_message_id ON public.whatsapp_messages USING btree (business_id, provider_message_id) WHERE (provider_message_id IS NOT NULL);


--
-- Name: users on_auth_user_created; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


--
-- Name: bot_faqs set_bot_faqs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_bot_faqs_updated_at BEFORE UPDATE ON public.bot_faqs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: bot_settings set_bot_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_bot_settings_updated_at BEFORE UPDATE ON public.bot_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: business_hours set_business_hours_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_business_hours_updated_at BEFORE UPDATE ON public.business_hours FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: business_special_hours set_business_special_hours_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_business_special_hours_updated_at BEFORE UPDATE ON public.business_special_hours FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: businesses set_businesses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_businesses_updated_at BEFORE UPDATE ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: categories set_categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: coupons set_coupons_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_coupons_updated_at BEFORE UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: customer_addresses set_customer_addresses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_customer_addresses_updated_at BEFORE UPDATE ON public.customer_addresses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: customers set_customers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inventory_ingredients set_inventory_ingredients_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_inventory_ingredients_updated_at BEFORE UPDATE ON public.inventory_ingredients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: loyalty_settings set_loyalty_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_loyalty_settings_updated_at BEFORE UPDATE ON public.loyalty_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: orders set_orders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payment_settings set_payment_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_payment_settings_updated_at BEFORE UPDATE ON public.payment_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payments set_payments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_payments_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_option_values set_product_option_values_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_product_option_values_updated_at BEFORE UPDATE ON public.product_option_values FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_options set_product_options_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_product_options_updated_at BEFORE UPDATE ON public.product_options FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: products set_products_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: profiles set_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: whatsapp_order_drafts set_updated_at_whatsapp_order_drafts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_whatsapp_order_drafts BEFORE UPDATE ON public.whatsapp_order_drafts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: whatsapp_conversations set_whatsapp_conversations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_whatsapp_conversations_updated_at BEFORE UPDATE ON public.whatsapp_conversations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: whatsapp_integrations set_whatsapp_integrations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_whatsapp_integrations_updated_at BEFORE UPDATE ON public.whatsapp_integrations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: bot_faqs bot_faqs_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_faqs
    ADD CONSTRAINT bot_faqs_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: bot_settings bot_settings_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_settings
    ADD CONSTRAINT bot_settings_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: business_hours business_hours_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_hours
    ADD CONSTRAINT business_hours_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: business_members business_members_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_members
    ADD CONSTRAINT business_members_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: business_members business_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_members
    ADD CONSTRAINT business_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: business_special_hours business_special_hours_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_special_hours
    ADD CONSTRAINT business_special_hours_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: categories categories_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: coupons coupons_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: customer_addresses customer_addresses_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: customer_addresses customer_addresses_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customers customers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: inventory_ingredients inventory_ingredients_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_ingredients
    ADD CONSTRAINT inventory_ingredients_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: loyalty_settings loyalty_settings_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_settings
    ADD CONSTRAINT loyalty_settings_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: order_item_options order_item_options_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_options
    ADD CONSTRAINT order_item_options_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: order_item_options order_item_options_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_options
    ADD CONSTRAINT order_item_options_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: order_payment_proofs order_payment_proofs_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_payment_proofs
    ADD CONSTRAINT order_payment_proofs_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: order_payment_proofs order_payment_proofs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_payment_proofs
    ADD CONSTRAINT order_payment_proofs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.whatsapp_conversations(id) ON DELETE SET NULL;


--
-- Name: order_payment_proofs order_payment_proofs_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_payment_proofs
    ADD CONSTRAINT order_payment_proofs_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_payment_proofs order_payment_proofs_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_payment_proofs
    ADD CONSTRAINT order_payment_proofs_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: order_status_history order_status_history_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT order_status_history_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: order_status_history order_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT order_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: order_status_history order_status_history_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT order_status_history_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: orders orders_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: orders orders_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE SET NULL;


--
-- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: orders orders_whatsapp_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_whatsapp_conversation_id_fkey FOREIGN KEY (whatsapp_conversation_id) REFERENCES public.whatsapp_conversations(id) ON DELETE SET NULL;


--
-- Name: payment_settings payment_settings_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settings
    ADD CONSTRAINT payment_settings_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: payments payments_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: payments payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: product_option_values product_option_values_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_option_values
    ADD CONSTRAINT product_option_values_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: product_option_values product_option_values_option_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_option_values
    ADD CONSTRAINT product_option_values_option_id_fkey FOREIGN KEY (option_id) REFERENCES public.product_options(id) ON DELETE CASCADE;


--
-- Name: product_options product_options_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_options
    ADD CONSTRAINT product_options_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: product_options product_options_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_options
    ADD CONSTRAINT product_options_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: products products_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: products products_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_conversations whatsapp_conversations_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversations
    ADD CONSTRAINT whatsapp_conversations_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: whatsapp_conversations whatsapp_conversations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversations
    ADD CONSTRAINT whatsapp_conversations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: whatsapp_integrations whatsapp_integrations_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_integrations
    ADD CONSTRAINT whatsapp_integrations_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: whatsapp_messages whatsapp_messages_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: whatsapp_messages whatsapp_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE;


--
-- Name: whatsapp_order_draft_items whatsapp_order_draft_items_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_draft_items
    ADD CONSTRAINT whatsapp_order_draft_items_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: whatsapp_order_draft_items whatsapp_order_draft_items_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_draft_items
    ADD CONSTRAINT whatsapp_order_draft_items_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.whatsapp_order_drafts(id) ON DELETE CASCADE;


--
-- Name: whatsapp_order_draft_items whatsapp_order_draft_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_draft_items
    ADD CONSTRAINT whatsapp_order_draft_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: whatsapp_order_drafts whatsapp_order_drafts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_drafts
    ADD CONSTRAINT whatsapp_order_drafts_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: whatsapp_order_drafts whatsapp_order_drafts_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_drafts
    ADD CONSTRAINT whatsapp_order_drafts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE;


--
-- Name: whatsapp_order_drafts whatsapp_order_drafts_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_drafts
    ADD CONSTRAINT whatsapp_order_drafts_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: inventory_ingredients admins delete inventory ingredients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins delete inventory ingredients" ON public.inventory_ingredients FOR DELETE TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: inventory_ingredients admins insert inventory ingredients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins insert inventory ingredients" ON public.inventory_ingredients FOR INSERT TO authenticated WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: bot_settings admins manage bot settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage bot settings" ON public.bot_settings TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: business_hours admins manage business hours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage business hours" ON public.business_hours TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: categories admins manage categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage categories" ON public.categories TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: coupons admins manage coupons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage coupons" ON public.coupons TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: bot_faqs admins manage faqs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage faqs" ON public.bot_faqs TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: whatsapp_integrations admins manage integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage integrations" ON public.whatsapp_integrations TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: loyalty_settings admins manage loyalty settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage loyalty settings" ON public.loyalty_settings TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: product_option_values admins manage option values; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage option values" ON public.product_option_values TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: payment_settings admins manage payment settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage payment settings" ON public.payment_settings TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: product_options admins manage product options; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage product options" ON public.product_options TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: products admins manage products; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage products" ON public.products TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: business_special_hours admins manage special hours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins manage special hours" ON public.business_special_hours TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: businesses admins update business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins update business" ON public.businesses FOR UPDATE TO authenticated USING (private.has_business_role(id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: inventory_ingredients admins update inventory ingredients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins update inventory ingredients" ON public.inventory_ingredients FOR UPDATE TO authenticated USING (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role])) WITH CHECK (private.has_business_role(business_id, ARRAY['owner'::public.business_role, 'admin'::public.business_role]));


--
-- Name: bot_faqs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_faqs ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: business_hours; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_hours ENABLE ROW LEVEL SECURITY;

--
-- Name: business_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_members ENABLE ROW LEVEL SECURITY;

--
-- Name: business_special_hours; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_special_hours ENABLE ROW LEVEL SECURITY;

--
-- Name: businesses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

--
-- Name: categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

--
-- Name: coupons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_addresses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_ingredients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_ingredients ENABLE ROW LEVEL SECURITY;

--
-- Name: loyalty_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.loyalty_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_addresses members manage customer_addresses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage customer_addresses" ON public.customer_addresses TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: customers members manage customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage customers" ON public.customers TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: order_item_options members manage order_item_options; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage order_item_options" ON public.order_item_options TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: order_items members manage order_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage order_items" ON public.order_items TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: order_status_history members manage order_status_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage order_status_history" ON public.order_status_history TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: orders members manage orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage orders" ON public.orders TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: payments members manage payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage payments" ON public.payments TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: whatsapp_conversations members manage whatsapp_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage whatsapp_conversations" ON public.whatsapp_conversations TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: whatsapp_messages members manage whatsapp_messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members manage whatsapp_messages" ON public.whatsapp_messages TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: customer_addresses members read customer_addresses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read customer_addresses" ON public.customer_addresses FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: customers members read customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read customers" ON public.customers FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: inventory_ingredients members read inventory ingredients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read inventory ingredients" ON public.inventory_ingredients FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: order_item_options members read order_item_options; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read order_item_options" ON public.order_item_options FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: order_items members read order_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read order_items" ON public.order_items FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: order_payment_proofs members read order_payment_proofs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read order_payment_proofs" ON public.order_payment_proofs FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: order_status_history members read order_status_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read order_status_history" ON public.order_status_history FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: orders members read orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read orders" ON public.orders FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: payments members read payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read payments" ON public.payments FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: whatsapp_conversations members read whatsapp_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read whatsapp_conversations" ON public.whatsapp_conversations FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: whatsapp_messages members read whatsapp_messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read whatsapp_messages" ON public.whatsapp_messages FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: whatsapp_order_draft_items members read whatsapp_order_draft_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read whatsapp_order_draft_items" ON public.whatsapp_order_draft_items FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: whatsapp_order_drafts members read whatsapp_order_drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members read whatsapp_order_drafts" ON public.whatsapp_order_drafts FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: order_payment_proofs members review order_payment_proofs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members review order_payment_proofs" ON public.order_payment_proofs FOR UPDATE TO authenticated USING (private.is_business_member(business_id)) WITH CHECK (private.is_business_member(business_id));


--
-- Name: business_hours members see business hours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members see business hours" ON public.business_hours FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: businesses members see inactive businesses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members see inactive businesses" ON public.businesses FOR SELECT TO authenticated USING (private.is_business_member(id));


--
-- Name: categories members see inactive categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members see inactive categories" ON public.categories FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: business_members members see membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members see membership" ON public.business_members FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR private.is_business_member(business_id)));


--
-- Name: product_options members see product options; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members see product options" ON public.product_options FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: product_option_values members see unavailable option values; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members see unavailable option values" ON public.product_option_values FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: products members see unavailable products; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members see unavailable products" ON public.products FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: bot_settings members view bot settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members view bot settings" ON public.bot_settings FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: bot_faqs members view faqs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members view faqs" ON public.bot_faqs FOR SELECT TO authenticated USING (private.is_business_member(business_id));


--
-- Name: order_item_options; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_item_options ENABLE ROW LEVEL SECURITY;

--
-- Name: order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: order_payment_proofs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_payment_proofs ENABLE ROW LEVEL SECURITY;

--
-- Name: order_status_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;

--
-- Name: orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: product_option_values; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_option_values ENABLE ROW LEVEL SECURITY;

--
-- Name: product_options; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_options ENABLE ROW LEVEL SECURITY;

--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles own select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "profiles own select" ON public.profiles FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = id));


--
-- Name: profiles profiles own update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "profiles own update" ON public.profiles FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = id)) WITH CHECK ((( SELECT auth.uid() AS uid) = id));


--
-- Name: businesses public active businesses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public active businesses" ON public.businesses FOR SELECT TO anon, authenticated USING (is_active);


--
-- Name: categories public active categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public active categories" ON public.categories FOR SELECT TO anon, authenticated USING ((is_active AND (EXISTS ( SELECT 1
   FROM public.businesses b
  WHERE ((b.id = categories.business_id) AND b.is_active)))));


--
-- Name: coupons public active coupons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public active coupons" ON public.coupons FOR SELECT TO anon, authenticated USING ((is_active AND (EXISTS ( SELECT 1
   FROM public.businesses b
  WHERE ((b.id = coupons.business_id) AND b.is_active)))));


--
-- Name: products public available products; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public available products" ON public.products FOR SELECT TO anon, authenticated USING ((is_available AND (EXISTS ( SELECT 1
   FROM public.businesses b
  WHERE ((b.id = products.business_id) AND b.is_active)))));


--
-- Name: business_hours public business hours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public business hours" ON public.business_hours FOR SELECT TO anon, authenticated USING ((EXISTS ( SELECT 1
   FROM public.businesses b
  WHERE ((b.id = business_hours.business_id) AND b.is_active))));


--
-- Name: loyalty_settings public loyalty settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public loyalty settings" ON public.loyalty_settings FOR SELECT TO anon, authenticated USING ((is_enabled AND (EXISTS ( SELECT 1
   FROM public.businesses b
  WHERE ((b.id = loyalty_settings.business_id) AND b.is_active)))));


--
-- Name: product_option_values public option values; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public option values" ON public.product_option_values FOR SELECT TO anon, authenticated USING ((is_available AND (EXISTS ( SELECT 1
   FROM ((public.product_options po
     JOIN public.products p ON ((p.id = po.product_id)))
     JOIN public.businesses b ON ((b.id = p.business_id)))
  WHERE ((po.id = product_option_values.option_id) AND (po.business_id = product_option_values.business_id) AND (p.business_id = product_option_values.business_id) AND p.is_available AND b.is_active)))));


--
-- Name: payment_settings public payment settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public payment settings" ON public.payment_settings FOR SELECT TO anon, authenticated USING ((EXISTS ( SELECT 1
   FROM public.businesses b
  WHERE ((b.id = payment_settings.business_id) AND b.is_active))));


--
-- Name: product_options public product options; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public product options" ON public.product_options FOR SELECT TO anon, authenticated USING ((EXISTS ( SELECT 1
   FROM (public.products p
     JOIN public.businesses b ON ((b.id = p.business_id)))
  WHERE ((p.id = product_options.product_id) AND (p.business_id = product_options.business_id) AND p.is_available AND b.is_active))));


--
-- Name: business_special_hours public special hours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public special hours" ON public.business_special_hours FOR SELECT TO anon, authenticated USING ((EXISTS ( SELECT 1
   FROM public.businesses b
  WHERE ((b.id = business_special_hours.business_id) AND b.is_active))));


--
-- Name: whatsapp_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_order_draft_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_order_draft_items ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_order_drafts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_order_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA private; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA private TO authenticated;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION has_business_role(target_business_id uuid, allowed_roles public.business_role[]); Type: ACL; Schema: private; Owner: -
--

GRANT ALL ON FUNCTION private.has_business_role(target_business_id uuid, allowed_roles public.business_role[]) TO authenticated;


--
-- Name: FUNCTION is_business_member(target_business_id uuid); Type: ACL; Schema: private; Owner: -
--

GRANT ALL ON FUNCTION private.is_business_member(target_business_id uuid) TO authenticated;


--
-- Name: FUNCTION agent_context(p_business_id uuid, p_conversation_id uuid, p_k integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_context(p_business_id uuid, p_conversation_id uuid, p_k integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_context(p_business_id uuid, p_conversation_id uuid, p_k integer) TO service_role;


--
-- Name: FUNCTION agent_conversation_handoff(p_business_id uuid, p_conversation_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_conversation_handoff(p_business_id uuid, p_conversation_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_conversation_handoff(p_business_id uuid, p_conversation_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION agent_draft_add_item(p_business_id uuid, p_conversation_id uuid, p_product_id uuid, p_quantity integer, p_option_value_ids uuid[], p_notes text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_draft_add_item(p_business_id uuid, p_conversation_id uuid, p_product_id uuid, p_quantity integer, p_option_value_ids uuid[], p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_draft_add_item(p_business_id uuid, p_conversation_id uuid, p_product_id uuid, p_quantity integer, p_option_value_ids uuid[], p_notes text) TO service_role;


--
-- Name: FUNCTION agent_draft_cancel(p_business_id uuid, p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_draft_cancel(p_business_id uuid, p_conversation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_draft_cancel(p_business_id uuid, p_conversation_id uuid) TO service_role;


--
-- Name: TABLE whatsapp_order_drafts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_order_drafts TO anon;
GRANT ALL ON TABLE public.whatsapp_order_drafts TO authenticated;
GRANT ALL ON TABLE public.whatsapp_order_drafts TO service_role;


--
-- Name: FUNCTION agent_draft_ensure(p_business_id uuid, p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_draft_ensure(p_business_id uuid, p_conversation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_draft_ensure(p_business_id uuid, p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION agent_draft_get(p_business_id uuid, p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_draft_get(p_business_id uuid, p_conversation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_draft_get(p_business_id uuid, p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION agent_draft_json(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_draft_json(p_conversation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_draft_json(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION agent_draft_remove_item(p_business_id uuid, p_conversation_id uuid, p_item_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_draft_remove_item(p_business_id uuid, p_conversation_id uuid, p_item_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_draft_remove_item(p_business_id uuid, p_conversation_id uuid, p_item_id uuid) TO service_role;


--
-- Name: FUNCTION agent_draft_set_details(p_business_id uuid, p_conversation_id uuid, p_customer_name text, p_order_type text, p_delivery_address text, p_payment_method text, p_notes text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_draft_set_details(p_business_id uuid, p_conversation_id uuid, p_customer_name text, p_order_type text, p_delivery_address text, p_payment_method text, p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_draft_set_details(p_business_id uuid, p_conversation_id uuid, p_customer_name text, p_order_type text, p_delivery_address text, p_payment_method text, p_notes text) TO service_role;


--
-- Name: FUNCTION agent_order_add_draft_items(p_business_id uuid, p_conversation_id uuid, p_order_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_order_add_draft_items(p_business_id uuid, p_conversation_id uuid, p_order_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_order_add_draft_items(p_business_id uuid, p_conversation_id uuid, p_order_code text) TO service_role;


--
-- Name: FUNCTION agent_order_json(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_order_json(p_order_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_order_json(p_order_id uuid) TO service_role;


--
-- Name: FUNCTION agent_order_status(p_business_id uuid, p_conversation_id uuid, p_order_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_order_status(p_business_id uuid, p_conversation_id uuid, p_order_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_order_status(p_business_id uuid, p_conversation_id uuid, p_order_code text) TO service_role;


--
-- Name: FUNCTION agent_order_update_details(p_business_id uuid, p_conversation_id uuid, p_order_code text, p_order_type text, p_delivery_address text, p_payment_method text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_order_update_details(p_business_id uuid, p_conversation_id uuid, p_order_code text, p_order_type text, p_delivery_address text, p_payment_method text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_order_update_details(p_business_id uuid, p_conversation_id uuid, p_order_code text, p_order_type text, p_delivery_address text, p_payment_method text) TO service_role;


--
-- Name: FUNCTION agent_product_detail(p_business_id uuid, p_product_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_product_detail(p_business_id uuid, p_product_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_product_detail(p_business_id uuid, p_product_id uuid) TO service_role;


--
-- Name: TABLE orders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.orders TO anon;
GRANT ALL ON TABLE public.orders TO authenticated;
GRANT ALL ON TABLE public.orders TO service_role;


--
-- Name: FUNCTION agent_resolve_editable_order(p_business_id uuid, p_conversation_id uuid, p_order_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_resolve_editable_order(p_business_id uuid, p_conversation_id uuid, p_order_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_resolve_editable_order(p_business_id uuid, p_conversation_id uuid, p_order_code text) TO service_role;


--
-- Name: FUNCTION agent_search_faq(p_business_id uuid, p_query text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_search_faq(p_business_id uuid, p_query text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_search_faq(p_business_id uuid, p_query text, p_limit integer) TO service_role;


--
-- Name: FUNCTION agent_search_products(p_business_id uuid, p_query text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agent_search_products(p_business_id uuid, p_query text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_search_products(p_business_id uuid, p_query text, p_limit integer) TO service_role;


--
-- Name: FUNCTION business_is_open(p_business_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.business_is_open(p_business_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.business_is_open(p_business_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.business_is_open(p_business_id uuid) TO service_role;


--
-- Name: FUNCTION business_schedule_windows(p_business_id uuid, p_date date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.business_schedule_windows(p_business_id uuid, p_date date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.business_schedule_windows(p_business_id uuid, p_date date) TO service_role;


--
-- Name: FUNCTION create_business_with_owner(business_name text, business_slug text, business_phone text, business_address text, business_city text, business_description text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_business_with_owner(business_name text, business_slug text, business_phone text, business_address text, business_city text, business_description text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_business_with_owner(business_name text, business_slug text, business_phone text, business_address text, business_city text, business_description text) TO authenticated;
GRANT ALL ON FUNCTION public.create_business_with_owner(business_name text, business_slug text, business_phone text, business_address text, business_city text, business_description text) TO service_role;


--
-- Name: FUNCTION create_manual_sale(sale_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_manual_sale(sale_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_manual_sale(sale_payload jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.create_manual_sale(sale_payload jsonb) TO service_role;


--
-- Name: FUNCTION get_public_order(target_order_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_public_order(target_order_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_public_order(target_order_code text) TO anon;
GRANT ALL ON FUNCTION public.get_public_order(target_order_code text) TO authenticated;
GRANT ALL ON FUNCTION public.get_public_order(target_order_code text) TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION mark_order_paid(target_order_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_order_paid(target_order_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_order_paid(target_order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.mark_order_paid(target_order_id uuid) TO service_role;


--
-- Name: FUNCTION persist_order(order_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.persist_order(order_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.persist_order(order_payload jsonb) TO service_role;


--
-- Name: FUNCTION search_dashboard(target_business_id uuid, search_term text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.search_dashboard(target_business_id uuid, search_term text) TO anon;
GRANT ALL ON FUNCTION public.search_dashboard(target_business_id uuid, search_term text) TO authenticated;
GRANT ALL ON FUNCTION public.search_dashboard(target_business_id uuid, search_term text) TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION update_order_status(target_order_id uuid, new_status public.order_status, status_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.update_order_status(target_order_id uuid, new_status public.order_status, status_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_order_status(target_order_id uuid, new_status public.order_status, status_note text) TO authenticated;
GRANT ALL ON FUNCTION public.update_order_status(target_order_id uuid, new_status public.order_status, status_note text) TO service_role;


--
-- Name: TABLE bot_faqs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bot_faqs TO anon;
GRANT ALL ON TABLE public.bot_faqs TO authenticated;
GRANT ALL ON TABLE public.bot_faqs TO service_role;


--
-- Name: TABLE bot_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bot_settings TO anon;
GRANT ALL ON TABLE public.bot_settings TO authenticated;
GRANT ALL ON TABLE public.bot_settings TO service_role;


--
-- Name: TABLE business_hours; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_hours TO anon;
GRANT ALL ON TABLE public.business_hours TO authenticated;
GRANT ALL ON TABLE public.business_hours TO service_role;


--
-- Name: TABLE business_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_members TO anon;
GRANT ALL ON TABLE public.business_members TO authenticated;
GRANT ALL ON TABLE public.business_members TO service_role;


--
-- Name: TABLE business_special_hours; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_special_hours TO anon;
GRANT ALL ON TABLE public.business_special_hours TO authenticated;
GRANT ALL ON TABLE public.business_special_hours TO service_role;


--
-- Name: TABLE businesses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.businesses TO anon;
GRANT ALL ON TABLE public.businesses TO authenticated;
GRANT ALL ON TABLE public.businesses TO service_role;


--
-- Name: TABLE categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.categories TO anon;
GRANT ALL ON TABLE public.categories TO authenticated;
GRANT ALL ON TABLE public.categories TO service_role;


--
-- Name: TABLE coupons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.coupons TO anon;
GRANT ALL ON TABLE public.coupons TO authenticated;
GRANT ALL ON TABLE public.coupons TO service_role;


--
-- Name: TABLE customer_addresses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_addresses TO anon;
GRANT ALL ON TABLE public.customer_addresses TO authenticated;
GRANT ALL ON TABLE public.customer_addresses TO service_role;


--
-- Name: TABLE customers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customers TO anon;
GRANT ALL ON TABLE public.customers TO authenticated;
GRANT ALL ON TABLE public.customers TO service_role;


--
-- Name: TABLE inventory_ingredients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.inventory_ingredients TO authenticated;
GRANT ALL ON TABLE public.inventory_ingredients TO service_role;


--
-- Name: TABLE loyalty_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.loyalty_settings TO anon;
GRANT ALL ON TABLE public.loyalty_settings TO authenticated;
GRANT ALL ON TABLE public.loyalty_settings TO service_role;


--
-- Name: TABLE order_item_options; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.order_item_options TO anon;
GRANT ALL ON TABLE public.order_item_options TO authenticated;
GRANT ALL ON TABLE public.order_item_options TO service_role;


--
-- Name: TABLE order_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.order_items TO anon;
GRANT ALL ON TABLE public.order_items TO authenticated;
GRANT ALL ON TABLE public.order_items TO service_role;


--
-- Name: TABLE order_payment_proofs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.order_payment_proofs TO anon;
GRANT ALL ON TABLE public.order_payment_proofs TO authenticated;
GRANT ALL ON TABLE public.order_payment_proofs TO service_role;


--
-- Name: TABLE order_status_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.order_status_history TO anon;
GRANT ALL ON TABLE public.order_status_history TO authenticated;
GRANT ALL ON TABLE public.order_status_history TO service_role;


--
-- Name: TABLE payment_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_settings TO anon;
GRANT ALL ON TABLE public.payment_settings TO authenticated;
GRANT ALL ON TABLE public.payment_settings TO service_role;


--
-- Name: TABLE payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payments TO anon;
GRANT ALL ON TABLE public.payments TO authenticated;
GRANT ALL ON TABLE public.payments TO service_role;


--
-- Name: TABLE product_option_values; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.product_option_values TO anon;
GRANT ALL ON TABLE public.product_option_values TO authenticated;
GRANT ALL ON TABLE public.product_option_values TO service_role;


--
-- Name: TABLE product_options; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.product_options TO anon;
GRANT ALL ON TABLE public.product_options TO authenticated;
GRANT ALL ON TABLE public.product_options TO service_role;


--
-- Name: TABLE products; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.products TO anon;
GRANT ALL ON TABLE public.products TO authenticated;
GRANT ALL ON TABLE public.products TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE whatsapp_conversations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_conversations TO anon;
GRANT ALL ON TABLE public.whatsapp_conversations TO authenticated;
GRANT ALL ON TABLE public.whatsapp_conversations TO service_role;


--
-- Name: TABLE whatsapp_integrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_integrations TO anon;
GRANT ALL ON TABLE public.whatsapp_integrations TO authenticated;
GRANT ALL ON TABLE public.whatsapp_integrations TO service_role;


--
-- Name: TABLE whatsapp_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_messages TO anon;
GRANT ALL ON TABLE public.whatsapp_messages TO authenticated;
GRANT ALL ON TABLE public.whatsapp_messages TO service_role;


--
-- Name: TABLE whatsapp_order_draft_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_order_draft_items TO anon;
GRANT ALL ON TABLE public.whatsapp_order_draft_items TO authenticated;
GRANT ALL ON TABLE public.whatsapp_order_draft_items TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--

\unrestrict ay1PbtMMcxiHu7B874RerX4VPVcfnPXVA1PQJOTVsD0ePbJSirsiZBegFkd0ZDv

