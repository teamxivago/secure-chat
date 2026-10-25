import { getSql } from "@veil/database";
import { authenticate, json, route } from "@/lib/server/http";
import { requireMember } from "@/lib/server/chats";

/**
 * Active device addresses of chat members, used to distribute this device's sender key over
 * pairwise sessions. Paginated by user id for very large groups.
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  const { chat, member } = await requireMember(id, ctx.userId);
  const after = req.nextUrl.searchParams.get("after") ?? "";
  const only = req.nextUrl.searchParams.get("userIds")?.split(",").filter(Boolean);
  // In channels only admins post, so only admins need subscribers' device lists.
  if (chat.type === "channel" && member.role === "member") return json({ devices: [], next: null });
  const sql = getSql();
  const rows = await sql<{ user_id: string; device_id: string; registration_id: number }[]>`
    select m.user_id, d.id as device_id, d.registration_id
    from chat_member m join device d on d.user_id = m.user_id and d.status = 'active'
    where m.chat_id = ${id} and m.user_id > ${after}
      ${only?.length ? sql`and m.user_id = any(${only})` : sql``}
    order by m.user_id
    limit 2000`;
  let next: string | null = null;
  if (rows.length === 2000) {
    // Never split one user's devices across pages: drop the trailing user and resume from the one before.
    const last = rows[rows.length - 1].user_id;
    while (rows.length && rows[rows.length - 1].user_id === last) rows.pop();
    next = rows.length ? rows[rows.length - 1].user_id : null;
  }
  return json({
    devices: rows.map((r) => ({ userId: r.user_id, deviceId: r.device_id, registrationId: r.registration_id })),
    next,
  });
});
