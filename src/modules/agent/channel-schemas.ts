import { z } from "zod";
export const id = z.string().min(1).max(500);
export const envelope = z.object({ id, event: z.string().max(100) }).passthrough();
export const inboxEvent = envelope.extend({
  account: z.object({ accountId: id }), conversation: z.object({ id }),
  message: z.object({ id, platformMessageId: id, platform: z.literal("whatsapp"), direction: z.enum(["incoming", "outgoing"]),
    text: z.string().max(16000).nullable(), sentAt: z.string().datetime({ offset: true }), sentVia: z.string().nullable().optional(), source: z.string().optional(),
    sender: z.object({ id, phoneNumber: z.string().nullable().optional(), businessScopedUserId: id.optional() }),
    attachments: z.array(z.object({ type: z.string(), url: z.string().url(), mimeType: z.string().optional() })).max(10).default([])
  }),
  metadata: z.object({ standby: z.boolean().optional(), interactiveId: z.string().max(300).optional(), interactiveType: z.string().optional() }).passthrough().nullish(),
  source: z.string().optional()
});
export type InboxEvent = z.infer<typeof inboxEvent>;
