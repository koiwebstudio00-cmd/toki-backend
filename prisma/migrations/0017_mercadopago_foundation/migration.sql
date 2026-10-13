-- Phase 1 stores connections and payment infrastructure. It does not enable collection.
create table public.mp_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  environment text not null check (environment in ('test', 'production')),
  seller_id text,
  status text not null default 'disconnected' check (status in ('disconnected', 'connected', 'reconnect_required')),
  acceptance_mode text not null default 'manual' check (acceptance_mode in ('manual', 'automatic')),
  oauth_generation integer not null default 0,
  refresh_started_at timestamptz,
  connected_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, environment),
  unique (environment, seller_id),
  unique (business_id, environment, id),
  check (status <> 'connected' or (seller_id is not null and expires_at is not null))
);
create table public.mp_credentials (
  connection_id uuid primary key references public.mp_connections(id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  scope text not null,
  updated_at timestamptz not null default now()
);
create table public.mp_oauth_flows (
  state_hash text primary key,
  business_id uuid not null,
  environment text not null,
  connection_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  generation integer not null,
  verifier_ciphertext text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (business_id, environment, connection_id)
    references public.mp_connections(business_id, environment, id) on delete cascade
);
create index mp_oauth_flows_expiry on public.mp_oauth_flows(expires_at);
create index mp_oauth_flows_business on public.mp_oauth_flows(business_id);

-- Cash registers can only be enabled after validating their ownership with MP in phase 2.
create table public.mp_registers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  environment text not null,
  connection_id uuid not null,
  store_id text not null,
  pos_id text not null,
  terminal_id text,
  channel text not null check (channel in ('qr_static', 'point_qr')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, environment, connection_id, id),
  unique (environment, pos_id),
  unique (environment, terminal_id),
  check ((channel = 'point_qr') = (terminal_id is not null)),
  foreign key (business_id, environment, connection_id)
    references public.mp_connections(business_id, environment, id) on delete cascade
);
create unique index orders_mp_scope on public.orders(business_id, id);
create table public.mp_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  environment text not null,
  connection_id uuid not null,
  register_id uuid not null,
  order_id uuid not null,
  expected_amount numeric(12,2) not null check (expected_amount > 0),
  currency text not null default 'ARS' check (currency = 'ARS'),
  order_updated_at timestamptz not null,
  external_reference text not null unique,
  idempotency_key uuid not null unique,
  provider_order_id text,
  provider_payment_id text,
  provider_status text,
  provider_status_detail text,
  status text not null default 'created' check (status in ('created', 'pending', 'unknown', 'paid', 'failed', 'canceled', 'expired', 'refunded')),
  acceptance_mode text not null check (acceptance_mode in ('manual', 'automatic')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  last_checked_at timestamptz,
  foreign key (business_id, environment, connection_id, register_id)
    references public.mp_registers(business_id, environment, connection_id, id),
  foreign key (business_id, order_id) references public.orders(business_id, id),
  unique (connection_id, provider_order_id),
  unique (connection_id, provider_payment_id)
);
create index mp_attempts_business_created on public.mp_payment_attempts(business_id, created_at);
create unique index mp_attempts_active_order on public.mp_payment_attempts(order_id)
  where status in ('created', 'pending', 'unknown');
create unique index mp_attempts_active_register on public.mp_payment_attempts(register_id)
  where status in ('created', 'pending', 'unknown');

-- Redacted envelope only. Workers in phase 2 will query the provider for the actual resource.
create table public.mp_webhook_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  environment text not null,
  connection_id uuid not null,
  provider_event_id text not null,
  resource_id text not null,
  action text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (connection_id, provider_event_id),
  foreign key (business_id, environment, connection_id)
    references public.mp_connections(business_id, environment, id)
);
create index mp_events_pending on public.mp_webhook_events(status, available_at);
create index mp_events_business on public.mp_webhook_events(business_id);

-- No browser role can forge credentials, payment results or provider events.
do $$
declare table_name text;
begin
  foreach table_name in array array['mp_connections','mp_credentials','mp_oauth_flows','mp_registers','mp_payment_attempts','mp_webhook_events'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    if table_name <> 'mp_oauth_flows' then
      execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name);
    end if;
  end loop;
  foreach table_name in array array['mp_connections','mp_registers','mp_payment_attempts'] loop
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('create policy members_read on public.%I for select to authenticated using (private.is_business_member(business_id))', table_name);
  end loop;
end $$;
