-- ============================================================================
-- Toki — bootstrap de producción. Se corre como toki_owner sobre la base `toki`.
--
-- Crea el rol de conexión de la API y le otorga los tres roles de contexto.
-- Es idempotente y NO depende del orden: sirve tanto si se corre antes del
-- primer deploy como después (la migración 0002 solo otorga los roles si el rol
-- ya existe, y una migración aplicada no se vuelve a correr — sin este archivo,
-- arrancar la API primero dejaba a toki_app sin permisos para siempre).
--
-- Password: openssl rand -hex 32   (nunca base64: el "/" rompe la connection string)
-- En zsh no usar `read -s -p` (sintaxis bash). Pegar el valor a mano abajo.
-- ============================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toki_app') THEN
    -- NOINHERIT es el corazón del modelo: la API se conecta con un rol que no
    -- puede leer nada por sí mismo. Cada query adopta anon, authenticated o
    -- service_role dentro de la transacción, y RLS decide qué ve.
    CREATE ROLE toki_app LOGIN NOINHERIT PASSWORD '<PEGAR_HEX_64>';
    RAISE NOTICE 'toki_app creado.';
  ELSE
    RAISE NOTICE 'toki_app ya existía: no se toca la password.';
  END IF;
END $$;

GRANT CONNECT ON DATABASE toki TO toki_app;

-- Los tres roles de contexto. Se otorgan siempre: si la migración 0002 corrió
-- antes de que existiera toki_app, este es el único lugar que lo arregla.
GRANT anon, authenticated, service_role TO toki_app;

-- ── Verificación ────────────────────────────────────────────────────────────
-- Esperado: rolsuper = f, rolbypassrls = f, rolinherit = f
SELECT rolname, rolsuper, rolbypassrls, rolinherit
FROM pg_roles WHERE rolname = 'toki_app';

-- Esperado: tres filas (anon, authenticated, service_role)
SELECT r.rolname AS rol_de_contexto
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.roleid
JOIN pg_roles g ON g.oid = m.member
WHERE g.rolname = 'toki_app'
ORDER BY 1;
