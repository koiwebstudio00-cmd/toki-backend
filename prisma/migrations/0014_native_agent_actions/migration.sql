-- Internal action journal. A started/uncertain action is NEVER retried automatically:
-- the business operation may have committed before its receipt was saved.
create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  message_id uuid not null references public.whatsapp_messages(id) on delete cascade,
  tool_name text not null,
  input_hash text not null,
  status text not null default 'started' check (status in ('started', 'completed', 'uncertain')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (message_id, tool_name, input_hash),
  check ((status = 'completed') = (result is not null and completed_at is not null))
);
-- One potentially unfinished business operation per conversation, across processes.
create unique index agent_actions_unfinished_conversation on public.agent_actions(conversation_id)
  where status in ('started', 'uncertain');
create index agent_actions_business_created on public.agent_actions(business_id, created_at);
alter table public.agent_actions enable row level security;
revoke all on public.agent_actions from public, anon, authenticated;
grant select, insert, update, delete on public.agent_actions to service_role;

-- Composite foreign keys prevent attaching a receipt to a different tenant/contact.
create unique index whatsapp_messages_agent_identity on public.whatsapp_messages(business_id, conversation_id, id);
alter table public.agent_actions add constraint agent_actions_message_scope
  foreign key (business_id, conversation_id, message_id)
  references public.whatsapp_messages(business_id, conversation_id, id) on delete cascade;
