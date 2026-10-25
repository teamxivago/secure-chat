import type { Content } from "@veil/shared";
import { formatDuration, snippet } from "@veil/shared";

export function contentPreview(c: Content): string {
  switch (c.t) {
    case "text":
      return snippet(c.text, 100);
    case "media": {
      if (c.onceView) return c.kind === "video" ? "⏱ Once-view video" : "⏱ Once-view photo";
      const label: Record<string, string> = {
        photo: "📷 Photo",
        video: "🎥 Video",
        audio: "🎵 " + (c.attachment.name ?? "Audio"),
        voice: `🎤 Voice message${c.attachment.duration ? ` (${formatDuration(c.attachment.duration)})` : ""}`,
        document: "📄 " + (c.attachment.name ?? "Document"),
        sticker: `${c.sticker?.emoji ?? ""} Sticker`.trim(),
        gif: "GIF",
      };
      return c.caption ? `${label[c.kind].split(" ")[0]} ${snippet(c.caption, 80)}` : label[c.kind];
    }
    case "location":
      return "📍 " + (c.label ?? "Location");
    case "contact":
      return "👤 " + c.name;
    case "poll":
      return "📊 " + snippet(c.question, 80);
    case "event":
      return "📅 " + snippet(c.title, 80);
    case "call":
      return (c.video ? "📹 " : "📞 ") + (c.outcome === "missed" ? "Missed call" : c.outcome === "declined" ? "Declined call" : c.outcome === "cancelled" ? "Cancelled call" : "Call");
    case "system":
      return c.text ?? "";
  }
}
