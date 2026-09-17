-- ============================================================================
-- Toki — 0002_auth_sessions
-- Tablas de la auth propia (reemplaza Supabase Auth). Mismo diseño que back-lamelas:
-- tokens opacos, en BD solo su hash SHA-256, refresh rotativo.
-- Solo la API las toca, siempre con el contexto service_role (módulo auth).
-- ============================================================================

create table auth.refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  token_hash  text not null unique,
  user_agent  text,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  replaced_by uuid references auth.refresh_tokens(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index idx_refresh_tokens_user on auth.refresh_tokens(user_id) where revoked_at is null;

create table auth.email_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  purpose     text not null check (purpose in ('verify_email', 'reset_password')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index idx_email_tokens_user_purpose on auth.email_tokens(user_id, purpose) where used_at is null;

create trigger set_auth_users_updated_at before update on auth.users
  for each row execute function public.set_updated_at();

-- Las tablas de auth solo se leen/escriben desde el contexto de sistema de la API.
-- anon/authenticated necesitan USAGE del schema para evaluar auth.uid() en policies,
-- pero no tienen privilegios sobre ninguna tabla de auth.
revoke all on all tables in schema auth from public, anon, authenticated;
grant usage on schema auth to anon, authenticated, service_role;
grant select, insert, update, delete on auth.users, auth.refresh_tokens, auth.email_tokens to service_role;
-- auth.uid() se usa desde policies y funciones con rol authenticated
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Rol de conexión de la API: lo crea scripts/bootstrap-prod.sql (con password fuera
-- del repo) antes del primer deploy. Acá solo se le dan los roles de contexto.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toki_app') THEN
    GRANT anon, authenticated, service_role TO toki_app;
  ELSE
    RAISE WARNING 'toki_app no existe: correr scripts/bootstrap-prod.sql y volver a otorgar roles';
  END IF;
END $$;
