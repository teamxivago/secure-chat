import type { Attachment, Content, MediaKind } from "@veil/shared";
import { deleteMessage, putMessage } from "../lib/db";
import type { StoredMessage } from "../lib/types";
import { bus } from "./bus";
import { ensureChat } from "./chats";
import { ctx } from "./context";
import { audioDuration, imageInfo, uploadEncrypted, videoInfo } from "./media";
import { sendMessage, setTyping, type SendOptions } from "./messages";
import { tsKey } from "./receive";

/**
 * Attachment sending with optimistic UI: a local placeholder renders immediately with upload
 * progress; once the encrypted upload completes, the real message (with key) is sent.
 */

const controllers = new Map<string, AbortController>();
const progress = new Map<string, number>();

export const uploadProgress = (id: string) => progress.get(id);

export function cancelUpload(id: string) {
  controllers.get(id)?.abort();
}

export function kindFor(file: File, asDocument: boolean): MediaKind {
  if (asDocument) return "document";
  if (file.type === "image/gif") return "gif";
  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") return "photo";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "document";
}

export interface MediaSendOptions extends SendOptions {
  asDocument?: boolean;
  caption?: string;
  onceViewTtl?: number;
  kind?: MediaKind;
  waveform?: number[];
  duration?: number;
}

export async function sendFile(chatId: string, file: File, opts: MediaSendOptions = {}) {
  await ensureChat(chatId);
  const kind = opts.kind ?? kindFor(file, !!opts.asDocument);
  const id = crypto.randomUUID();
  const meta: Partial<Attachment> = { mime: file.type || "application/octet-stream", name: file.name, size: file.size };
  try {
    if (kind === "photo" || kind === "gif") Object.assign(meta, await imageInfo(file));
    else if (kind === "video") Object.assign(meta, await videoInfo(file));
    else if (kind === "audio" || kind === "voice") meta.duration = opts.duration ?? (await audioDuration(file));
  } catch {
    /* metadata is optional */
  }
  if (opts.waveform) meta.waveform = opts.waveform;
  if (opts.duration) meta.duration = opts.duration;
  // Once-view items never carry a preview thumbnail.
  if (opts.onceViewTtl) delete meta.thumbnail;

  const placeholder: StoredMessage = {
    id,
    chatId,
    senderId: ctx.userId,
    ts: Date.now(),
    sortKey: chatId.startsWith("u:") ? tsKey(Date.now(), id) : `z${String(Date.now()).padStart(14, "0")}:${id}`,
    content: {
      t: "media",
      kind,
      caption: opts.caption || undefined,
      onceView: opts.onceViewTtl ? { ttl: opts.onceViewTtl } : undefined,
      attachment: { mediaId: `local:${id}`, key: "", size: file.size, encryptedSize: 0, ...meta } as Attachment,
    },
    meta: {},
    outgoing: true,
    status: "pending",
    reactions: {},
    receipts: {},
  };
  await putMessage(placeholder);
  bus.emit("messages:changed", { chatId, ids: [id] });

  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  const typing = setInterval(() => void setTyping(chatId, kind === "voice" ? "recording" : "uploading"), 4000);
  void setTyping(chatId, "uploading");
  try {
    const up = await uploadEncrypted(file, {
      signal: ctrl.signal,
      ttl: opts.onceViewTtl,
      onProgress: (f) => {
        progress.set(id, f);
        bus.emit("upload:progress", { messageId: id, progress: f });
      },
    });
    const content: Content = { ...(placeholder.content as Extract<Content, { t: "media" }>), attachment: { ...(placeholder.content as Extract<Content, { t: "media" }>).attachment, ...up } };
    return await sendMessage(chatId, content, { ...opts, id });
  } catch (e) {
    await deleteMessage(id);
    bus.emit("messages:changed", { chatId, ids: [], removed: [id] });
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    clearInterval(typing);
    void setTyping(chatId, "stop");
    controllers.delete(id);
    progress.delete(id);
  }
}
