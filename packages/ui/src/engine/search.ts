import { forEachMessage } from "../lib/db";
import type { StoredMessage } from "../lib/types";
import { contentPreview } from "./preview";

/**
 * On-device full-text search. Messages are E2EE, so search runs locally over the decrypted
 * store — nothing about the query or the results ever reaches a server.
 */

export interface SearchFilters {
  chatId?: string;
  senderId?: string;
  from?: number;
  to?: number;
  type?: "all" | "media" | "photo" | "video" | "document" | "link" | "audio" | "voice" | "gif";
  limit?: number;
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function searchableText(m: StoredMessage): string {
  const c = m.content;
  switch (c.t) {
    case "text":
      return [c.text, c.preview?.title, c.preview?.description].filter(Boolean).join(" ");
    case "media":
      return [c.caption, c.attachment.name].filter(Boolean).join(" ");
    case "poll":
      return [c.question, ...c.options.map((o) => o.text)].join(" ");
    case "event":
      return [c.title, c.location, c.description].filter(Boolean).join(" ");
    case "location":
      return [c.label, c.address].filter(Boolean).join(" ");
    case "contact":
      return [c.name, c.phone, c.username].filter(Boolean).join(" ");
    default:
      return contentPreview(c);
  }
}

function matchesType(m: StoredMessage, t: SearchFilters["type"]): boolean {
  if (!t || t === "all") return true;
  const c = m.content;
  if (t === "link") return c.t === "text" && /https?:\/\//i.test(c.text);
  if (c.t !== "media") return false;
  if (t === "media") return c.kind === "photo" || c.kind === "video";
  return c.kind === t;
}

export async function searchMessages(query: string, f: SearchFilters = {}): Promise<StoredMessage[]> {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  const out: StoredMessage[] = [];
  const limit = f.limit ?? 200;
  await forEachMessage((m) => {
    if (m.content.t === "system") return;
    if (f.senderId && m.senderId !== f.senderId) return;
    if (f.from && m.ts < f.from) return;
    if (f.to && m.ts > f.to) return;
    if (!matchesType(m, f.type)) return;
    if (terms.length) {
      const text = norm(searchableText(m));
      if (!terms.every((t) => text.includes(t))) return;
    }
    out.push(m);
    if (out.length >= limit * 4) return false;
  }, f.chatId);
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** Shared media tab: everything with an attachment / link in a chat. */
export async function sharedMedia(chatId: string, kind: "photos" | "videos" | "files" | "links" | "audio") {
  const map = { photos: "photo", videos: "video", files: "document", links: "link", audio: "audio" } as const;
  const res = await searchMessages("", { chatId, type: map[kind], limit: 2000 });
  if (kind === "audio") return [...res, ...(await searchMessages("", { chatId, type: "voice", limit: 2000 }))].sort((a, b) => b.ts - a.ts);
  if (kind === "photos") return [...res, ...(await searchMessages("", { chatId, type: "gif", limit: 500 }))].sort((a, b) => b.ts - a.ts);
  return res;
}
