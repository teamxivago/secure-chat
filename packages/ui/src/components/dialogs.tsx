"use client";
import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { contentPreview, ctx, forwardMessages } from "../engine";
import { useChats } from "../hooks";
import { cn } from "../lib/cn";
import { haptic } from "../lib/native";
import { useUI } from "../store/ui";
import { ChatAvatar, useChatIdentity } from "./chat-identity";
import { Dialog } from "./overlays";
import { Button, Input, Switch, Textarea } from "./primitives";
import type { LocalChat } from "../lib/types";

function PickRow({ chat, selected, onToggle }: { chat: LocalChat; selected: boolean; onToggle: () => void }) {
  const id = useChatIdentity(chat);
  return (
    <button onClick={onToggle} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface">
      <ChatAvatar chat={chat} size={42} />
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{id.name}</span>
      <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border-2", selected ? "border-accent bg-accent text-white" : "border-subtle")}>{selected && <Check className="h-4 w-4" />}</span>
    </button>
  );
}

export function ForwardDialog() {
  const { forwarding, set, clearSelection } = useUI();
  const { chats } = useChats();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [hideSender, setHideSender] = useState(false);
  const [busy, setBusy] = useState(false);
  const eligible = useMemo(
    () => chats.filter((c) => c.type !== "channel" || c.summary?.myRights?.postMessages).filter((c) => !q || (c.title ?? c.lastPreview ?? "").toLowerCase().includes(q.toLowerCase()) || c.id.includes(q)),
    [chats, q],
  );
  const close = () => {
    set({ forwarding: null });
    setPicked([]);
    setQ("");
  };
  async function send() {
    if (!forwarding) return;
    setBusy(true);
    try {
      await forwardMessages(forwarding, picked, !hideSender);
      void haptic("success");
      toast(`Forwarded to ${picked.length} chat${picked.length > 1 ? "s" : ""}`);
      clearSelection();
      close();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!forwarding} onOpenChange={(o) => !o && close()} title={`Forward ${forwarding?.length ?? 0} message${(forwarding?.length ?? 0) > 1 ? "s" : ""}`}>
      <Input leading={<Search className="h-4 w-4" />} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="my-2 max-h-72 overflow-y-auto">
        {eligible.map((c) => (
          <PickRow key={c.id} chat={c} selected={picked.includes(c.id)} onToggle={() => setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))} />
        ))}
      </div>
      <label className="flex items-center justify-between py-2 text-[15px]">
        Hide sender name
        <Switch checked={hideSender} onCheckedChange={setHideSender} />
      </label>
      <Button className="mt-2 w-full" disabled={!picked.length} loading={busy} onClick={send}>
        Forward
      </Button>
    </Dialog>
  );
}

const REASONS = [
  ["spam", "Spam"],
  ["violence", "Violence"],
  ["child_abuse", "Child abuse"],
  ["pornography", "Pornography"],
  ["illegal_drugs", "Illegal drugs"],
  ["personal_details", "Personal details"],
  ["copyright", "Copyright"],
  ["other", "Other"],
] as const;

export function ReportDialog() {
  const { reporting, set, clearSelection } = useUI();
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>("spam");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!reporting) return;
    setBusy(true);
    try {
      const msgs = reporting.messages;
      await ctx.api.reports.create({
        reason,
        comment: comment || undefined,
        chatId: reporting.chatId.startsWith("u:") ? undefined : reporting.chatId,
        targetUserId: msgs[0]?.senderId,
        // Reporting voluntarily discloses these messages to moderators.
        messages: msgs.map((m) => ({ id: m.id, senderId: m.senderId, ts: m.ts, content: m.content.t === "media" ? { ...m.content, attachment: { ...m.content.attachment, key: undefined } } : m.content })),
      });
      toast("Report sent. Thank you.");
      clearSelection();
      set({ reporting: null });
      setComment("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!reporting} onOpenChange={(o) => !o && set({ reporting: null })} title="Report" description="The selected messages will be shared with Veil moderators so they can review them.">
      {reporting?.messages.slice(0, 3).map((m) => (
        <div key={m.id} className="mb-1 truncate rounded-lg bg-surface px-3 py-2 text-sm text-muted">
          {contentPreview(m.content)}
        </div>
      ))}
      <div className="my-3 grid grid-cols-2 gap-2">
        {REASONS.map(([v, l]) => (
          <button key={v} onClick={() => setReason(v)} className={cn("rounded-xl px-3 py-2 text-sm", reason === v ? "bg-accent text-white" : "bg-surface")}>
            {l}
          </button>
        ))}
      </div>
      <Textarea rows={2} placeholder="Additional details (optional)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
      <Button className="mt-3 w-full" variant="danger" loading={busy} onClick={submit}>
        Send report
      </Button>
    </Dialog>
  );
}

