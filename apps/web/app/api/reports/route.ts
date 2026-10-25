import { z } from "zod";
import { getDb, schema } from "@veil/database";
import { authenticate, json, limit, parseBody, route } from "@/lib/server/http";

/** The reporter voluntarily discloses the reported messages' plaintext (the server can't read them otherwise). */
export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  await limit(`report:${ctx.userId}`, 30, 3600);
  const body = await parseBody(
    req,
    z.object({
      reason: z.enum(["spam", "violence", "child_abuse", "pornography", "illegal_drugs", "personal_details", "copyright", "other"]),
      comment: z.string().max(500).optional(),
      targetUserId: z.string().max(64).optional(),
      chatId: z.string().max(64).optional(),
      messages: z.array(z.object({ id: z.string(), senderId: z.string(), ts: z.number(), content: z.unknown() })).max(20).default([]),
    }),
  );
  await getDb().insert(schema.report).values({
    reporterId: ctx.userId,
    targetUserId: body.targetUserId ?? null,
    chatId: body.chatId ?? null,
    messageId: body.messages[0]?.id ?? null,
    reason: body.reason,
    disclosedContent: { comment: body.comment, messages: body.messages },
  });
  return json({ ok: true }, 201);
});
