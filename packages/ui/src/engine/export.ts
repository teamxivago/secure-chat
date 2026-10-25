import { forEachMessage } from "../lib/db";
import type { StoredMessage } from "../lib/types";
import { contentPreview } from "./preview";
import { ctx } from "./context";
import { displayName, getUsers } from "./users";

/** Exports a chat's history from the local decrypted store (export happens entirely on device). */
export async function exportChat(chatId: string, title: string, format: "json" | "txt"): Promise<Blob> {
  const msgs: StoredMessage[] = [];
  await forEachMessage((m) => void msgs.push(m), chatId);
  msgs.sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
  const users = await getUsers([...new Set(msgs.map((m) => m.senderId))]);
  const name = (id: string) => (id === ctx.account?.userId ? displayName(ctx.me) : displayName(users.get(id)));
  if (format === "json") {
    const data = {
      chat: { id: chatId, title },
      exportedAt: new Date().toISOString(),
      messages: msgs.map((m) => ({
        id: m.id,
        date: new Date(m.ts).toISOString(),
        from: name(m.senderId),
        fromId: m.senderId,
        edited: m.editedAt ? new Date(m.editedAt).toISOString() : undefined,
        replyTo: m.meta.replyTo?.id,
        forwardedFrom: m.meta.forwardedFrom?.name,
        content: m.content.t === "media" ? { ...m.content, attachment: { ...m.content.attachment, key: undefined, deleteToken: undefined } } : m.content,
        reactions: m.reactions,
      })),
    };
    return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  }
  const lines = [`${title} — exported ${new Date().toLocaleString()}`, ""];
  for (const m of msgs) {
    const d = new Date(m.ts);
    lines.push(`[${d.toLocaleDateString()} ${d.toLocaleTimeString()}] ${name(m.senderId)}: ${m.content.t === "text" ? m.content.text : contentPreview(m.content)}${m.editedAt ? " (edited)" : ""}`);
  }
  return new Blob([lines.join("\n")], { type: "text/plain" });
}
