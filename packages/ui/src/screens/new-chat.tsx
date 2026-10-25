"use client";
import { useQuery } from "@tanstack/react-query";
import { AtSign, Bookmark, Camera, Megaphone, Search, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { directChatId, type PublicUser } from "@veil/shared";
import { ctx, displayName, ensureChat, primeUser, refreshServerChats, uploadEncrypted } from "../engine";
import { cn } from "../lib/cn";
import { haptic } from "../lib/native";
import { useUI } from "../store/ui";
import { Avatar } from "../components/avatar";
import { Dialog, Sheet } from "../components/overlays";
import { Button, Input, Row, Spinner, Switch, Textarea } from "../components/primitives";
import { prepareAvatar, useUsernameCheck, UsernameHint } from "./auth";

function UserPickList({ q, picked, onToggle, single }: { q: string; picked: Set<string>; onToggle: (u: PublicUser) => void; single?: boolean }) {
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: () => ctx.api.contacts.list() });
  const dir = useQuery({ queryKey: ["dir", q], queryFn: () => ctx.api.users.search(q), enabled: q.trim().length >= 2 });
  const local = (contacts.data?.contacts ?? []).filter((u) => !q || displayName(u).toLowerCase().includes(q.toLowerCase()) || u.username?.includes(q.toLowerCase()));
  const remote = (dir.data?.users ?? []).filter((u) => !local.some((l) => l.id === u.id) && u.id !== ctx.account?.userId);
  const list = [...local, ...remote];
  if (contacts.isLoading) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (!list.length) return <p className="p-6 text-center text-sm text-muted">{q.length >= 2 ? "No one found" : "Search by name or @username"}</p>;
  return (
    <div>
      {list.map((u) => (
        <button key={u.id} onClick={() => onToggle(u)} className="flex w-full items-center gap-3 px-4 py-2 hover:bg-surface" data-testid="pick-user">
          <Avatar id={u.id} name={displayName(u)} mediaId={u.avatarMediaId} mediaKey={u.avatarKey} size={44} online={u.presence?.online} />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[15px] font-medium">{displayName(u)}</span>
            <span className="block truncate text-[13px] text-muted">{u.username ? `@${u.username}` : u.phoneNumber}</span>
          </span>
          {!single && <span className={cn("h-5 w-5 rounded-full border-2", picked.has(u.id) ? "border-accent bg-accent" : "border-subtle")} />}
        </button>
      ))}
    </div>
  );
}

function CreateChatDialog({ type, onClose }: { type: "group" | "channel" | null; onClose: () => void }) {
  const [step, setStep] = useState<"members" | "details">("members");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Map<string, PublicUser>>(new Map());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setPublic] = useState(false);
  const [username, setUsername] = useState("");
  const [avatar, setAvatar] = useState<{ file: Blob; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const openChat = useUI((s) => s.openChat);
  const check = useUsernameCheck(isPublic ? username : "");
  const isChannel = type === "channel";

  const reset = () => {
    setStep("members");
    setPicked(new Map());
    setTitle("");
    setDescription("");
    setPublic(false);
    setUsername("");
    setAvatar(null);
    onClose();
  };

  async function create() {
    setBusy(true);
    try {
      let avatarMediaId: string | undefined;
      let avatarKey: string | undefined;
      if (avatar) {
        const up = await uploadEncrypted(avatar.file);
        avatarMediaId = up.mediaId;
        avatarKey = up.key;
      }
      const s = await ctx.api.chats.create({
        type,
        title: title.trim(),
        description: description.trim() || undefined,
        isPublic,
        username: isPublic ? username : undefined,
        memberIds: [...picked.keys()],
        avatarMediaId,
        avatarKey,
      });
      await ensureChat(s.id, s);
      await refreshServerChats();
      void haptic("success");
      openChat(s.id);
      reset();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!type} onOpenChange={(o) => !o && reset()} title={step === "members" && !isChannel ? "Add members" : isChannel ? "New channel" : "New group"}>
      {step === "members" && !isChannel ? (
        <>
          <Input leading={<Search className="h-4 w-4" />} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          {picked.size > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {[...picked.values()].map((u) => (
                <span key={u.id} className="rounded-full bg-accent-soft px-2.5 py-1 text-[13px] text-accent">
                  {displayName(u)}
                </span>
              ))}
            </div>
          )}
          <div className="-mx-5 my-2 max-h-80 overflow-y-auto">
            <UserPickList q={q} picked={new Set(picked.keys())} onToggle={(u) => setPicked((p) => { const n = new Map(p); if (n.has(u.id)) n.delete(u.id); else n.set(u.id, u); return n; })} />
          </div>
          <Button className="w-full" onClick={() => setStep("details")}>
            Next
          </Button>
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <label className="relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-accent-soft text-accent">
              {avatar ? <img src={avatar.preview} alt="" className="h-full w-full object-cover" /> : <Camera className="h-6 w-6" />}
              <input type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const b = await prepareAvatar(f); setAvatar({ file: b, preview: URL.createObjectURL(b) }); } }} />
            </label>
            <Input className="flex-1" placeholder={isChannel ? "Channel name" : "Group name"} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={128} autoFocus />
          </div>
          <Textarea rows={2} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} />
          <label className="flex items-center justify-between text-[15px]">
            Public — anyone can find and join
            <Switch checked={isPublic} onCheckedChange={setPublic} />
          </label>
          {isPublic && (
            <div className="space-y-1">
              <Input leading={<AtSign className="h-4 w-4" />} placeholder="public_link" value={username} onChange={(e) => setUsername(e.target.value.trim())} />
              <UsernameHint state={check} />
            </div>
          )}
          <p className="text-[13px] text-muted">{isChannel ? "Only admins can post. Posts are end-to-end encrypted with Sender Keys." : `${picked.size} member${picked.size === 1 ? "" : "s"} · messages use Sender Keys end-to-end encryption.`}</p>
          <Button className="w-full" disabled={!title.trim() || (isPublic && check !== "available")} loading={busy} onClick={create}>
            Create {isChannel ? "channel" : "group"}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

export function NewChatSheet() {
  const { newChat, set, openChat } = useUI();
  const [q, setQ] = useState("");
  const [usernameOpen, setUsernameOpen] = useState(false);
  const [uname, setUname] = useState("");
  async function openUser(u: PublicUser) {
    primeUser(u);
    await ensureChat(directChatId(u.id));
    openChat(directChatId(u.id));
    set({ newChat: null });
  }
  return (
    <>
      <Sheet open={newChat === "menu"} onOpenChange={(o) => !o && set({ newChat: null })} title="New message">
        <div className="px-3 pb-2">
          <Input leading={<Search className="h-4 w-4" />} placeholder="Search name or @username" value={q} onChange={(e) => setQ(e.target.value)} data-testid="new-chat-search" />
        </div>
        {!q && (
          <div className="px-3 pb-2">
            <div className="overflow-hidden rounded-2xl bg-surface">
              <Row icon={<Users className="h-5 w-5" />} title="New group" onClick={() => set({ newChat: "group" })} />
              <Row icon={<Megaphone className="h-5 w-5" />} title="New channel" onClick={() => set({ newChat: "channel" })} />
              <Row icon={<UserPlus className="h-5 w-5" />} title="Find by username" onClick={() => setUsernameOpen(true)} />
              <Row icon={<Bookmark className="h-5 w-5" />} title="Saved Messages" onClick={() => (openChat(directChatId(ctx.userId)), set({ newChat: null }))} />
            </div>
          </div>
        )}
        <div className="max-h-[50vh] overflow-y-auto pb-4">
          <UserPickList q={q} picked={new Set()} single onToggle={openUser} />
        </div>
      </Sheet>
      <Dialog open={usernameOpen} onOpenChange={setUsernameOpen} title="Find by username">
        <Input leading={<AtSign className="h-4 w-4" />} value={uname} onChange={(e) => setUname(e.target.value.replace(/^@/, "").trim())} placeholder="username" />
        <Button
          className="mt-4 w-full"
          onClick={async () => {
            try {
              const u = await ctx.api.users.get(`@${uname}`);
              setUsernameOpen(false);
              await openUser(u);
            } catch {
              toast.error("No user with that username");
            }
          }}
        >
          Open chat
        </Button>
      </Dialog>
      <CreateChatDialog type={newChat === "group" || newChat === "channel" ? newChat : null} onClose={() => set({ newChat: null })} />
    </>
  );
}
