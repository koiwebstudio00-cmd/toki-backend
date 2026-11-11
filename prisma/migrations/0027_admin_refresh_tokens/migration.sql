-- Sesiones recordadas de Toki Admin. Separadas de auth.refresh_tokens para que un
-- refresh del panel de negocios nunca sirva en Admin ni al revés.
create table auth.admin_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  -- Una sesión pertenece a una versión administrativa: --reset o cambio de
  -- contraseña la invalidan aunque el token no haya vencido.
  session_version integer not null,
  user_agent text,
  -- Vencimiento absoluto desde el login: la rotación no lo extiende.
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid references auth.admin_refresh_tokens(id) on delete set null,
  created_at timestamptz not null default now()
);
create index admin_refresh_tokens_user_idx on auth.admin_refresh_tokens(user_id);
alter table auth.admin_refresh_tokens enable row level security;
revoke all on auth.admin_refresh_tokens from public, anon, authenticated;
grant select, insert, update, delete on auth.admin_refresh_tokens to service_role;
