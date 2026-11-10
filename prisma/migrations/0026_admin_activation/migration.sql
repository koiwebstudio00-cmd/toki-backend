alter table auth.users
  add column admin_access_enabled boolean not null default false,
  add column admin_totp_secret_encrypted text,
  add column admin_session_version integer not null default 0;

create table auth.admin_activations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  setup_token_hash text unique,
  password_hash text,
  full_name text,
  totp_secret_encrypted text,
  session_version integer not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  expires_at timestamptz not null,
  started_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index admin_activations_user_idx on auth.admin_activations(user_id);
alter table auth.admin_activations enable row level security;
revoke all on auth.admin_activations from public, anon, authenticated;
grant select, insert, update, delete on auth.admin_activations to service_role;
