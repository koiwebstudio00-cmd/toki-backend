-- ============================================================================
-- Toki — 0008_agente_v3_contexto
-- Fase V1 del agente v3 (toki-agents/docs/12-plan-agente-v3.md).
--
-- 1) Búsqueda por palabras (B2). `agent_search_products` y `agent_search_faq`
--    buscaban la frase entera con ILIKE: "ensalada de pollo" no encontraba
--    "Ensalada César con pollo" y "cesar" no encontraba "César". Ahora parten la
--    consulta en palabras, ignoran acentos y palabras vacías ("de", "con",
--    "quiero"...), toleran el plural y errores chicos de tipeo (pg_trgm) y
--    ordenan por cuántas palabras coinciden. Se mantiene la regla de stock de
--    0007: un producto sin `track_stock` siempre está disponible.
--
-- 2) Vencimiento del borrador (B7). El borrador vence a las 4 h sin cambios y
--    eso se mide con `whatsapp_order_drafts.updated_at`, que solo se movía al
--    cambiar la fila del borrador. Agregar, sacar o cambiar un item no la
--    tocaba. Un trigger sobre los items la actualiza.
--
-- 3) Sofi (B17). El asistente se llama Sofi por defecto. Los negocios que
--    nunca cambiaron el nombre ('Toki') pasan a Sofi; los que lo cambiaron
--    conservan el suyo.
-- ============================================================================

-- ── 1. Búsqueda ─────────────────────────────────────────────────────────────

-- Palabras útiles de una consulta: sin acentos, en minúscula, sin palabras
-- vacías y con el plural simple recortado ("empanadas" → "empanada"). La forma
-- de dos argumentos de unaccent es a propósito: con search_path vacío, la de un
-- argumento no encuentra el diccionario.
create or replace function public.agent_search_terms(p_query text) returns text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select coalesce(array_agg(distinct term), '{}')
  from (
    select case
      when length(t) > 4 and t like '%s' then left(t, length(t) - 1)
      else t
    end as term
    from regexp_split_to_table(
      lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p_query, ''))),
      '[^a-z0-9]+'
    ) as t
    where (length(t) >= 3 or t ~ '^[0-9]+$')
      and t not in (
        'del', 'las', 'los', 'una', 'uno', 'unos', 'unas', 'con', 'para', 'por', 'que',
        'algo', 'hay', 'tenes', 'tiene', 'tienen', 'quiero', 'queria', 'quisiera',
        'dame', 'pasame', 'mandame', 'vende', 'venden', 'cuanto', 'sale', 'salen',
        'precio', 'hola', 'buenas', 'buen', 'dia', 'porfa', 'favor'
      )
  ) terms
  where term <> '';
$$;

-- Normaliza un texto para comparar contra los términos.
create or replace function public.agent_search_text(p_text text) returns text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p_text, '')));
$$;

create or replace function public.agent_search_products(p_business_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 6) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  -- Tope bajo a propósito: al modelo hay que darle un puñado de opciones
  -- buenas, no el catálogo entero.
  with terms as (
    select public.agent_search_terms(p_query) as list
  ),
  candidates as (
    select
      p.id,
      p.name,
      p.description,
      p.price,
      c.name as category,
      p.is_featured,
      p.sort_order,
      public.agent_search_text(p.name) as name_text,
      public.agent_search_text(concat_ws(' ', p.description, c.name)) as other_text
    from public.products p
    left join public.categories c on c.id = p.category_id
    where p.business_id = p_business_id
      and p.is_available
      and (not p.track_stock or p.stock_quantity > 0)
  ),
  scored as (
    select
      cand.*,
      -- Coincidir en el nombre vale el doble que en la descripción o la
      -- categoría. word_similarity tolera plurales raros y errores de tipeo.
      (
        select coalesce(sum(case
          when cand.name_text like '%' || term || '%'
            or extensions.word_similarity(term, cand.name_text) >= 0.6 then 2
          when cand.other_text like '%' || term || '%'
            or extensions.word_similarity(term, cand.other_text) >= 0.6 then 1
          else 0
        end), 0)
        from unnest(terms.list) as term
      ) as score,
      cardinality(terms.list) as term_count
    from candidates cand
    cross join terms
  )
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  from (
    select
      s.id,
      s.name,
      s.description,
      s.price,
      s.category,
      -- Si tiene opciones obligatorias, el agente tiene que preguntar antes de
      -- agregarlo: se lo decimos explícitamente en vez de que lo deduzca.
      exists (
        select 1 from public.product_options o
        where o.product_id = s.id and o.is_required
      ) as requiere_opciones,
      true as con_stock
    from scored s
    -- Sin términos útiles (consulta vacía o solo palabras vacías) vuelven los
    -- destacados, como antes.
    where s.term_count = 0 or s.score > 0
    order by s.score desc, s.is_featured desc, s.sort_order, s.name
    limit least(greatest(p_limit, 1), 12)
  ) t;
$$;

create or replace function public.agent_search_faq(p_business_id uuid, p_query text, p_limit integer DEFAULT 3) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  with terms as (
    select public.agent_search_terms(p_query) as list
  ),
  scored as (
    select
      f.question,
      f.answer,
      f.created_at,
      (
        select coalesce(sum(case
          when public.agent_search_text(f.question) like '%' || term || '%' then 2
          when public.agent_search_text(f.answer) like '%' || term || '%' then 1
          else 0
        end), 0)
        from unnest(terms.list) as term
      ) as score
    from public.bot_faqs f
    cross join terms
    where f.business_id = p_business_id
      and f.is_active
  )
  select coalesce(jsonb_agg(jsonb_build_object('question', s.question, 'answer', s.answer)), '[]'::jsonb)
  from (
    select question, answer
    from scored
    where score > 0
    order by score desc, created_at
    limit least(greatest(p_limit, 1), 5)
  ) s;
$$;

grant execute on function public.agent_search_terms(text) to service_role;
grant execute on function public.agent_search_text(text) to service_role;

-- ── 2. Vencimiento del borrador ─────────────────────────────────────────────

create or replace function public.touch_whatsapp_order_draft() returns trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  update public.whatsapp_order_drafts
  set updated_at = now()
  where id = coalesce(new.draft_id, old.draft_id);
  return null;
end $$;

create trigger touch_draft_on_item_change
  after insert or update or delete on public.whatsapp_order_draft_items
  for each row execute function public.touch_whatsapp_order_draft();

-- ── 3. Sofi ─────────────────────────────────────────────────────────────────

alter table public.bot_settings alter column bot_name set default 'Sofi';
update public.bot_settings set bot_name = 'Sofi' where bot_name = 'Toki';
