-- A temporary cart is NOT an order: no stock, coupon, loyalty or customer writes.
create table public.catalog_requests (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  request_id uuid not null,
  input_hash text not null,
  input jsonb not null,
  quote_hash text not null,
  message text not null,
  message_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  conversation_id uuid references public.whatsapp_conversations(id) on delete set null,
  order_id uuid references public.orders(id) on delete restrict,
  unique (business_id, request_id)
);
create index catalog_requests_expiry_idx on public.catalog_requests(expires_at) where order_id is null;
create index catalog_requests_conversation_idx on public.catalog_requests(conversation_id);
create index catalog_requests_order_idx on public.catalog_requests(order_id);
alter table public.catalog_requests enable row level security;
revoke all on public.catalog_requests from public, anon, authenticated;
grant select, insert, update, delete on public.catalog_requests to service_role;
-- No public/member policies: access only through tenant-scoped API operations.
