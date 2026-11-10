import { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/db.js";
import type { ListConversationsQuery } from "./schemas.js";

export async function listContactThreads(tx: Tx, businessId: string, q: ListConversationsQuery) {
  const [page] = await tx.$queryRaw<{ total: number; ids: string[] }[]>`
    with contacts as (
      select id, status, handoff_reason, current_case_id, last_message_at, created_at,
        case when phone ~ '^[+]?[1-9][0-9]{6,14}$' then ltrim(phone, '+') else id::text end as contact
      from public.whatsapp_conversations where business_id = ${businessId}::uuid
    ), threads as (
      select distinct on (contact) id, status, handoff_reason, created_at,
        max(last_message_at) over (partition by contact) as latest_message_at
      from contacts
      order by contact, (status = 'handoff' or current_case_id is not null) desc,
        last_message_at desc nulls last, created_at desc, id desc
    ), filtered as (
      select * from threads
      where (${q.status ?? null}::text is null or status = ${q.status ?? null})
        and (${q.reason ?? null}::text is null or handoff_reason = ${q.reason ?? null})
    )
    select count(*)::int as total, array(
      select id from filtered order by latest_message_at desc nulls last, created_at desc, id desc
      offset ${(q.page - 1) * q.limit} limit ${q.limit}
    ) as ids from filtered
  `;
  return page!;
}

export async function latestProfileNames(tx: Tx, businessId: string, ids: string[]) {
  if (!ids.length) return [];
  return tx.$queryRaw<{ conversationId: string; name: string; createdAt: Date }[]>`
    select distinct on (conversation_id) conversation_id as "conversationId",
      left(btrim(raw_payload #>> '{message,sender,name}'), 160) as name, created_at as "createdAt"
    from public.whatsapp_messages
    where business_id = ${businessId}::uuid
      and conversation_id in (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      and direction = 'inbound'
      and jsonb_typeof(raw_payload #> '{message,sender,name}') = 'string'
      and nullif(btrim(raw_payload #>> '{message,sender,name}'), '') is not null
    order by conversation_id, created_at desc, id desc
  `;
}
