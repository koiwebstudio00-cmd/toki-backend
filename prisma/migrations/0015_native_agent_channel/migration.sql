alter table public.whatsapp_messages add column received_at timestamptz not null default now();
alter table public.bot_settings add column engine text not null default 'legacy' check (engine in ('legacy','native'));
alter table public.bot_settings add column daily_turn_limit integer not null default 500 check (daily_turn_limit between 1 and 10000);
create table public.agent_webhook_events (id text primary key, created_at timestamptz not null default now());
create table public.agent_turns (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id) on delete cascade,
 conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
 message_id uuid not null unique, account_id text not null, provider_conversation_id text not null,
 status text not null default 'queued' check(status in ('queued','running','ready','sending','sent','skipped','failed','uncertain')),
 available_at timestamptz not null default now(), claimed_at timestamptz, reply text, buttons jsonb, provider_message_id text,
 error_code text, usage jsonb, configuration jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key (business_id,conversation_id,message_id) references public.whatsapp_messages(business_id,conversation_id,id) on delete cascade
);
create index agent_turns_queue on public.agent_turns(status,available_at);
create index agent_turns_business_created on public.agent_turns(business_id,created_at desc);
create unique index agent_turns_active_conversation on public.agent_turns(conversation_id) where status in ('running','sending');
create table public.agent_approvals (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id) on delete cascade,
 conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade, message_id uuid not null,
 tool_name text not null, args jsonb not null, quote jsonb not null,
 status text not null default 'pending' check(status in ('pending','executing','approved','denied','expired','failed')),
 expires_at timestamptz not null, created_at timestamptz not null default now(),
 foreign key (business_id,conversation_id,message_id) references public.whatsapp_messages(business_id,conversation_id,id) on delete cascade
);
create unique index agent_approvals_pending on public.agent_approvals(conversation_id) where status in ('pending','executing');
alter table public.agent_webhook_events enable row level security;
alter table public.agent_turns enable row level security;
alter table public.agent_approvals enable row level security;
revoke all on public.agent_webhook_events,public.agent_turns,public.agent_approvals from public,anon,authenticated;
grant select,insert,update,delete on public.agent_webhook_events,public.agent_turns,public.agent_approvals to service_role;
