-- A provider failure can arrive before the HTTP send response. Retain it so the
-- outbox acknowledgement can reconcile in either arrival order.
alter table public.agent_webhook_events add column failure jsonb;
create index agent_webhook_failure_identity on public.agent_webhook_events
 ((failure->>'accountId'), (failure->>'messageId')) where failure is not null;
create index agent_turns_budget_day on public.agent_turns(business_id,(configuration->>'budgetDay'))
 where configuration is not null;
