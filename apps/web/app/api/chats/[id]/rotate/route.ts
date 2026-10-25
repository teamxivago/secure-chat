import { authenticate, json, route } from "@/lib/server/http";
import { bumpEpoch, requireRight } from "@/lib/server/chats";

/** Admin-initiated group key rotation: every member device generates a new sender key chain. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  await requireRight(id, ctx.userId, "changeInfo");
  const epoch = await bumpEpoch(id, "admin_rotation", ctx.userId);
  return json({ epoch });
});
