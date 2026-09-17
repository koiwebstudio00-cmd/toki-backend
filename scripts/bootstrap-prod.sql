-- ============================================================================
-- Toki — bootstrap de producción. Correr UNA vez, como toki_owner, ANTES del
-- primer deploy de toki-api (la migración 0002 le otorga los roles de contexto).
--
-- Password: openssl rand -hex 32   (nunca base64: el "/" rompe la connection string)
-- En zsh no usar `read -s -p` (sintaxis bash). Pegar el valor a mano.
-- ============================================================================

create role toki_app login noinherit password '<PEGAR_HEX_64>';
grant connect on database toki to toki_app;

-- Verificación esperada: rolsuper = f, rolbypassrls = f, rolinherit = f
select rolname, rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = 'toki_app';
