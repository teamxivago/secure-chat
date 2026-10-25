import { z } from "zod";
import { getSql } from "@veil/database";
import { authenticate, json, limit, parseBody, route } from "@/lib/server/http";
import { requireMember } from "@/lib/server/chats";

/** Channel post view counting: one view per user per post. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  const { ids } = await parseBody(req, z.object({ ids: z.array(z.string().max(64)).min(1).max(100) }));
  await limit(`views:${ctx.userId}`, 600, 60);
  await requireMember(id, ctx.userId);
  const sql = getSql();
  const counts = await sql<{ id: string; view_count: number }[]>`
    with ins as (
      insert into channel_post_view (message_id, user_id)
      select m.id, ${ctx.userId} from group_message m where m.chat_id = ${id} and m.id = any(${ids})
      on conflict do nothing returning message_id
    )
    update group_message set view_count = view_count + 1 where id in (select message_id from ins)
    returning id, view_count`;
  return json({ views: Object.fromEntries(counts.map((c) => [c.id, c.view_count])) });
});
