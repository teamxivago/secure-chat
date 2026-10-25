import { getDb, getSql } from "./client";
import { sticker, stickerPack } from "./schema";

/** Seeds the built-in sticker pack (SVG assets shipped in apps/web/public/stickers/veil). */
const EMOJI = [
  ["wave", "👋"], ["love", "😍"], ["laugh", "😂"], ["cool", "😎"], ["party", "🥳"], ["think", "🤔"],
  ["cry", "😭"], ["angry", "😡"], ["sleep", "😴"], ["fire", "🔥"], ["heart", "❤️"], ["thumbs", "👍"],
  ["clap", "👏"], ["pray", "🙏"], ["rocket", "🚀"], ["star", "⭐"], ["coffee", "☕"], ["gift", "🎁"],
  ["ok", "👌"], ["shock", "😱"], ["wink", "😉"], ["hug", "🤗"], ["sparkles", "✨"], ["100", "💯"],
] as const;

const db = getDb();
await db
  .insert(stickerPack)
  .values({ id: "pack_veil", name: "veil_classics", title: "Veil Classics", author: "Veil", isDefault: true, thumbnailStickerId: "stk_veil_wave" })
  .onConflictDoNothing();
await db
  .insert(sticker)
  .values(EMOJI.map(([slug, emoji], i) => ({ id: `stk_veil_${slug}`, packId: "pack_veil", emoji, mime: "image/svg+xml", url: `/stickers/veil/${slug}.svg`, position: i })))
  .onConflictDoNothing();
console.log("seeded sticker pack");
await getSql().end();
