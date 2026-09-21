-- ============================================================================
-- Toki — 0004_public_is_open
-- Permisos que Supabase daba por defecto y el dump del schema no trajo.
--
-- 1) `business_is_open`: el menú público ahora le pregunta a la base si el
--    negocio está abierto, en vez de recalcular horarios en JavaScript como
--    hacían el front y la Edge Function `create-order` (dos implementaciones
--    del mismo cálculo que podían discrepar). Es STABLE y SECURITY DEFINER:
--    no expone nada más que un booleano.
--
-- 2) Esquema `extensions`: ahí viven unaccent y pg_trgm. `search_dashboard`
--    (el buscador del panel) es una función SQL común, así que corre con los
--    permisos de quien la llama y necesita USAGE sobre ese esquema. En
--    Supabase venía concedido de fábrica.
-- ============================================================================

grant execute on function public.business_is_open(uuid) to anon;

grant usage on schema extensions to anon, authenticated, service_role;
