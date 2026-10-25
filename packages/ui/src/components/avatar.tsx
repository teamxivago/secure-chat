"use client";
import { Bookmark, Megaphone, Users } from "lucide-react";
import { initials } from "@veil/shared";
import { cn } from "../lib/cn";
import { useAttachment } from "../hooks";

const GRADIENTS = [
  ["#00A88E", "#2AABEE"],
  ["#7C5CFF", "#C56CF0"],
  ["#FF7A59", "#FF4D8D"],
  ["#2AABEE", "#5B7CFA"],
  ["#F5A524", "#FF7A59"],
  ["#22C55E", "#00A88E"],
  ["#EC4899", "#8B5CF6"],
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({
  id,
  name,
  mediaId,
  mediaKey,
  size = 48,
  online,
  kind = "user",
  className,
}: {
  id: string;
  name: string;
  mediaId?: string | null;
  mediaKey?: string | null;
  size?: number;
  online?: boolean;
  kind?: "user" | "group" | "channel" | "self";
  className?: string;
}) {
  const { url } = useAttachment(mediaId && mediaKey ? { mediaId, key: mediaKey, mime: "image/jpeg", encryptedSize: 0 } : null, "photo", true);
  const [a, b] = GRADIENTS[hash(id) % GRADIENTS.length];
  const fontSize = Math.max(11, Math.round(size * 0.38));
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt={name} className="h-full w-full rounded-full object-cover" draggable={false} />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white"
          style={{ background: kind === "self" ? "linear-gradient(135deg,#2AABEE,#00A88E)" : `linear-gradient(135deg, ${a}, ${b})`, fontSize }}
        >
          {kind === "self" ? <Bookmark style={{ width: size * 0.42, height: size * 0.42 }} /> : kind === "channel" && !name ? <Megaphone /> : kind === "group" && !name ? <Users /> : initials(name)}
        </div>
      )}
      {online && <span className="absolute bottom-0 right-0 rounded-full border-2 border-bg bg-online" style={{ width: Math.max(10, size * 0.26), height: Math.max(10, size * 0.26) }} />}
    </div>
  );
}
