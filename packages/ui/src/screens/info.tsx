"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  Ban,
  Bell,
  BellOff,
  Camera,
  ChevronRight,
  Clock,
  Copy,
  Crown,
  FileText,
  Image as ImageIcon,
  Link2,
  Lock,
  LogOut,
  MessageCircle,
  Mic,
  Phone,
  Plus,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Video,
  X,
  Info as InfoIcon,
  Smile,
  Link as LinkIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ADMIN_RIGHTS,
  DEFAULT_REACTIONS,
  directChatId,
  formatBytes,
  INVITE_EXPIRY_OPTIONS,
  MEMBER_PERMISSIONS,
  presenceLabel,
  SLOW_MODE_OPTIONS,
  type AdminRight,
  type ChatMemberInfo,
  type ChatSummary,
} from "@veil/shared";
import { safetyNumber, fromB64 } from "@veil/crypto";
import {
  addContact,
  ctx,
  displayName,
  muteChat,
  refreshServerChat,
  removeContact,
  setBlocked,
  setLocalName,
  sharedMedia,
  startCall,
  uploadEncrypted,
  vaultWrite,
} from "../engine";
import { kvGet } from "../lib/db";
import { useChat, useUser, useAttachment } from "../hooks";
import { cn } from "../lib/cn";
import { formatChatTime, plural } from "../lib/format";
import { haptic } from "../lib/native";
import type { StoredMessage } from "../lib/types";
import { useUI } from "../store/ui";
import { Avatar } from "../components/avatar";
import { ChatAvatar } from "../components/chat-identity";
import { openExternal, RichText } from "../components/content";
import { Dialog, Menu, useConfirm } from "../components/overlays";
import { Button, IconButton, Input, Row, Section, Segmented, Spinner, Switch, Textarea } from "../components/primitives";
import { prepareAvatar, useUsernameCheck, UsernameHint } from "./auth";

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="safe-top sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-bg/85 px-2 backdrop-blur-xl">
      <IconButton label="Close" onClick={onClose}>
        <X className="h-5 w-5" />
      </IconButton>
      <h2 className="text-[17px] font-semibold">{title}</h2>
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, danger }: { icon: typeof Phone; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={() => (void haptic("light"), onClick())} className={cn("flex flex-1 flex-col items-center gap-1 rounded-2xl bg-surface py-2.5 text-[12px] font-medium transition hover:bg-surface-2", danger ? "text-danger" : "text-accent")}>
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

/* ------------------------------ shared media ------------------------------ */

function MediaThumb({ m, onOpen }: { m: StoredMessage; onOpen: () => void }) {
  const c = m.content.t === "media" ? m.content : null;
  const { url } = useAttachment(c && !c.gif ? c.attachment : null, "photo");
  const src = c?.gif ? (c.gif.previewUrl ?? c.gif.url) : url ?? c?.attachment.thumbnail;
  return (
    <button onClick={onOpen} className="relative aspect-square overflow-hidden bg-surface-2">
      {src && (c?.kind === "video" && url ? <video src={url} className="h-full w-full object-cover" muted /> : <img src={src.startsWith("/") ? ctx.api.baseUrl + src : src} alt="" className="h-full w-full object-cover" />)}
      {c?.kind === "video" && <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1 text-[10px] text-white">▶</span>}
    </button>
  );
}

export function SharedMedia({ chatId }: { chatId: string }) {
  const [tab, setTab] = useState<"photos" | "videos" | "files" | "links" | "audio">("photos");
  const [items, setItems] = useState<StoredMessage[] | null>(null);
  const [q, setQ] = useState("");
  const { set, jumpTo } = useUI();
  useEffect(() => {
    setItems(null);
    void sharedMedia(chatId, tab).then(setItems);
  }, [chatId, tab]);
  const filtered = useMemo(() => {
    if (!items || !q) return items;
    const s = q.toLowerCase();
    return items.filter((m) => JSON.stringify(m.content).toLowerCase().includes(s));
  }, [items, q]);
  const groups = useMemo(() => {
    const g = new Map<string, StoredMessage[]>();
    for (const m of filtered ?? []) {
      const k = new Date(m.ts).toLocaleDateString([], { month: "long", year: "numeric" });
      g.set(k, [...(g.get(k) ?? []), m]);
    }
    return [...g.entries()];
  }, [filtered]);
  return (
    <div>
      <div className="px-3 pb-2">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "photos", label: "Media" },
            { value: "videos", label: "Videos" },
            { value: "files", label: "Files" },
            { value: "links", label: "Links" },
            { value: "audio", label: "Voice" },
          ]}
        />
        {(tab === "files" || tab === "links") && <Input className="mt-2" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      {!filtered ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted">Nothing shared yet</p>
      ) : (
        groups.map(([label, list]) => (
          <div key={label}>
            <div className="px-4 py-1.5 text-[13px] font-medium text-muted">{label}</div>
            {tab === "photos" || tab === "videos" ? (
              <div className="grid grid-cols-3 gap-0.5">
                {list.map((m) => (
                  <MediaThumb key={m.id} m={m} onOpen={() => set({ viewer: { items: list, index: list.indexOf(m) } })} />
                ))}
              </div>
            ) : (
              list.map((m) => {
                const c = m.content;
                const url = c.t === "text" ? c.text.match(/https?:\/\/\S+/)?.[0] : undefined;
                return (
                  <button
                    key={m.id}
                    onClick={() => (tab === "links" && url ? openExternal(url) : jumpTo(m.chatId, m.id))}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                      {tab === "links" ? <LinkIcon className="h-5 w-5" /> : tab === "audio" ? <Mic className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px]">
                        {tab === "links" ? (c.t === "text" ? c.preview?.title ?? url : "") : c.t === "media" ? c.attachment.name ?? (c.kind === "voice" ? "Voice message" : "Audio") : ""}
                      </span>
                      <span className="block truncate text-[13px] text-muted">
                        {tab === "links" ? url : c.t === "media" ? `${formatBytes(c.attachment.size)} · ${formatChatTime(m.ts)}` : ""}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        ))
      )}
    </div>
  );
}

/* ------------------------------ user profile ------------------------------ */

export function UserPanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const u = useUser(userId);
  const chatId = directChatId(userId);
  const chat = useChat(chatId);
  const { openChat } = useUI();
  const confirm = useConfirm();
  const [safety, setSafety] = useState<string | null>(null);
  const [nickOpen, setNickOpen] = useState(false);
  const [nick, setNick] = useState("");
  const muted = (chat?.mutedUntil ?? 0) > Date.now();
  if (!u) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  async function showSafety() {
    const mine = await ctx.store.getIdentityKeyPair();
    const theirs = await kvGet<Uint8Array>(`rid:${userId}.${(await kvGet<{ deviceId: string }[]>(`devs:${userId}`))?.[0]?.deviceId}`);
    const devs = await kvGet<{ identityKey?: string }[]>(`devs:${userId}`);
    const key = theirs ?? (devs?.[0]?.identityKey ? fromB64(devs[0].identityKey) : null);
    if (!key) return toast("Send a message first to establish a secure session");
    setSafety(safetyNumber(ctx.userId, mine.publicKey, userId, key));
  }

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <PanelHeader title="Info" onClose={onClose} />
      <div className="flex flex-col items-center px-6 pb-4 pt-6 text-center">
        <Avatar id={u.id} name={displayName(u)} mediaId={u.avatarMediaId} mediaKey={u.avatarKey} size={112} />
        <h2 className="mt-3 flex items-center gap-1.5 text-[22px] font-semibold">
          {displayName(u)} {u.emojiStatus && <span>{u.emojiStatus}</span>}
        </h2>
        <p className={cn("text-[14px]", u.presence?.online ? "text-accent" : "text-muted")}>{u.blocked ? "blocked" : u.presence ? presenceLabel(u.presence) : ""}</p>
      </div>
      <div className="flex gap-2 px-4 pb-5">
        <ActionButton icon={MessageCircle} label="Message" onClick={() => (openChat(chatId), onClose())} />
        {!u.blocked && <ActionButton icon={Phone} label="Call" onClick={() => void startCall({ userId }, false, displayName(u)).catch((e) => toast.error(e.message))} />}
        {!u.blocked && <ActionButton icon={Video} label="Video" onClick={() => void startCall({ userId }, true, displayName(u)).catch((e) => toast.error(e.message))} />}
        <ActionButton icon={muted ? Bell : BellOff} label={muted ? "Unmute" : "Mute"} onClick={() => void muteChat(chatId, muted ? null : Number.MAX_SAFE_INTEGER)} />
      </div>
      <div className="px-3">
        <Section>
          {u.username && <Row icon={<AtSign className="h-5 w-5" />} title={`@${u.username}`} subtitle="Username" onClick={() => navigator.clipboard.writeText(`@${u.username}`).then(() => toast("Username copied"))} trailing={<Copy className="h-4 w-4 text-subtle" />} />}
          {u.phoneNumber && <Row icon={<Phone className="h-5 w-5" />} title={u.phoneNumber} subtitle="Mobile" onClick={() => navigator.clipboard.writeText(u.phoneNumber!).then(() => toast("Phone copied"))} />}
          {u.bio && <Row icon={<InfoIcon className="h-5 w-5" />} title={<RichText text={u.bio} />} subtitle="Bio" />}
        </Section>
        <Section>
          <Row icon={<ShieldCheck className="h-5 w-5" />} title="Verify security code" subtitle="Compare to confirm end-to-end encryption" onClick={showSafety} trailing={<ChevronRight className="h-4 w-4 text-subtle" />} />
          <Row
            icon={<UserPlus className="h-5 w-5" />}
            title={u.isContact ? "Edit contact name" : "Add to contacts"}
            onClick={() => {
              setNick(u.localName ?? displayName(u));
              setNickOpen(true);
            }}
          />
          {u.isContact && <Row icon={<UserMinus className="h-5 w-5" />} title="Remove from contacts" danger onClick={() => removeContact(userId).then(() => toast("Removed"))} />}
          <Row
            icon={<Ban className="h-5 w-5" />}
            title={u.blocked ? "Unblock user" : "Block user"}
            danger={!u.blocked}
            onClick={async () => {
              if (!u.blocked) {
                const r = await confirm({ title: `Block ${displayName(u)}?`, confirm: "Block", danger: true });
                if (!r.ok) return;
              }
              await setBlocked(userId, !u.blocked);
              toast(u.blocked ? "Unblocked" : "Blocked");
            }}
          />
        </Section>
        <h3 className="mb-1.5 px-1 text-[13px] font-medium uppercase tracking-wide text-muted">Shared media</h3>
      </div>
      <SharedMedia chatId={chatId} />
      <div className="h-10" />
      <Dialog open={!!safety} onOpenChange={(o) => !o && setSafety(null)} title="Security code" description={`Compare these numbers with ${displayName(u)} in person or over a call. If they match, your chat is end-to-end encrypted with the right person.`}>
        <div className="grid grid-cols-4 gap-x-4 gap-y-2 rounded-2xl bg-surface p-4 text-center font-mono text-lg tracking-wider">
          {safety?.match(/.{5}/g)?.map((g, i) => <span key={i}>{g}</span>)}
        </div>
      </Dialog>
      <Dialog open={nickOpen} onOpenChange={setNickOpen} title={u.isContact ? "Edit contact" : "Add contact"} description="Names you set are private and synced only between your devices.">
        <Input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="Name" />
        <Button
          className="mt-4 w-full"
          onClick={async () => {
            if (!u.isContact) await addContact(u, nick);
            else {
              await setLocalName(userId, nick);
              vaultWrite("contact", userId, { name: nick });
            }
            setNickOpen(false);
            toast("Saved");
          }}
        >
          Save
        </Button>
      </Dialog>
    </div>
  );
}

/* ------------------------------ group / channel info ------------------------------ */

function MemberRow({ m, chat, onChanged }: { m: ChatMemberInfo; chat: ChatSummary; onChanged: () => void }) {
  const [rightsOpen, setRightsOpen] = useState(false);
  const confirm = useConfirm();
  const { openChat, setPanel } = useUI();
  const me = ctx.account!.userId;
  const canManage = chat.myRights.banUsers && m.userId !== me && m.role !== "owner" && (m.role !== "admin" || chat.myRole === "owner");
  const canPromote = chat.myRights.addAdmins && m.userId !== me && m.role !== "owner";
  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2 hover:bg-surface">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => m.userId !== me && setPanel({ kind: "user", userId: m.userId })}>
          <Avatar id={m.userId} name={displayName(m.user)} mediaId={m.user.avatarMediaId} mediaKey={m.user.avatarKey} size={42} online={m.user.presence?.online} />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-medium">{m.userId === me ? "You" : displayName(m.user)}</span>
            <span className="block truncate text-[13px] text-muted">{m.user.presence ? presenceLabel(m.user.presence) : ""}</span>
          </span>
        </button>
        {m.role !== "member" && <span className="flex items-center gap-1 text-[12px] font-medium text-accent">{m.role === "owner" ? <Crown className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}{m.title ?? (m.role === "owner" ? "owner" : "admin")}</span>}
        {(canManage || canPromote) && (
          <Menu
            trigger={<IconButton label="Member actions"><SlidersHorizontal className="h-4 w-4" /></IconButton>}
            items={[
              { label: "Message", icon: <MessageCircle />, onSelect: () => openChat(directChatId(m.userId)) },
              { label: m.role === "admin" ? "Edit admin rights" : "Promote to admin", icon: <Shield />, hidden: !canPromote, onSelect: () => setRightsOpen(true) },
              {
                label: "Dismiss admin",
                icon: <Shield />,
                hidden: !canPromote || m.role !== "admin",
                onSelect: async () => {
                  await ctx.api.chats.setMember(chat.id, m.userId, { role: "member" });
                  onChanged();
                },
              },
              {
                label: "Transfer ownership",
                icon: <Crown />,
                hidden: chat.myRole !== "owner" || m.userId === me,
                onSelect: async () => {
                  const r = await confirm({ title: `Make ${displayName(m.user)} the owner?`, body: "You'll become an admin.", confirm: "Transfer", danger: true });
                  if (r.ok) {
                    await ctx.api.chats.setMember(chat.id, m.userId, { role: "owner" });
                    onChanged();
                  }
                },
              },
              {
                label: chat.type === "channel" ? "Remove subscriber" : "Remove from group",
                icon: <UserMinus />,
                danger: true,
                hidden: !canManage,
                onSelect: async () => {
                  const r = await confirm({ title: `Remove ${displayName(m.user)}?`, confirm: "Remove", danger: true, checkbox: "Ban (prevent rejoining)" });
                  if (r.ok) {
                    await ctx.api.chats.removeMember(chat.id, m.userId, r.checked);
                    onChanged();
                  }
                },
              },
            ]}
          />
        )}
      </div>
      <AdminRightsDialog open={rightsOpen} onClose={() => setRightsOpen(false)} chat={chat} member={m} onSaved={onChanged} />
    </>
  );
}

const RIGHT_LABELS: Record<AdminRight, string> = {
  changeInfo: "Change info",
  deleteMessages: "Delete messages",
  banUsers: "Ban users",
  inviteUsers: "Invite users via link",
  pinMessages: "Pin messages",
  manageReactions: "Manage reactions",
  addAdmins: "Add new admins",
  setSlowMode: "Set slow mode",
  manageBots: "Manage bots",
  postMessages: "Post messages",
  manageCalls: "Manage calls",
};

function AdminRightsDialog({ open, onClose, chat, member, onSaved }: { open: boolean; onClose: () => void; chat: ChatSummary; member: ChatMemberInfo; onSaved: () => void }) {
  const [rights, setRights] = useState<Record<string, boolean>>({});
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle(member.title ?? "");
    setRights(member.role === "admin" ? { ...member.rights } : { changeInfo: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, manageReactions: true, setSlowMode: true, postMessages: chat.type === "channel", manageCalls: true });
  }, [open, member, chat.type]);
  const relevant = ADMIN_RIGHTS.filter((r) => (chat.type === "channel" ? r !== "setSlowMode" : r !== "postMessages"));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={`Admin rights · ${displayName(member.user)}`}>
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {relevant.map((r) => (
          <label key={r} className="flex items-center justify-between rounded-xl px-2 py-2 text-[15px] hover:bg-surface">
            {RIGHT_LABELS[r]}
            <Switch checked={!!rights[r]} disabled={chat.myRole !== "owner" && !chat.myRights[r]} onCheckedChange={(v) => setRights({ ...rights, [r]: v })} />
          </label>
        ))}
      </div>
      <Input className="mt-3" placeholder="Custom title (e.g. Moderator)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={16} />
      <Button
        className="mt-4 w-full"
        onClick={async () => {
          await ctx.api.chats.setMember(chat.id, member.userId, { role: "admin", rights, title: title || null });
          toast("Admin rights saved");
          onSaved();
          onClose();
        }}
      >
        Save
      </Button>
    </Dialog>
  );
}

function InviteLinksDialog({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: ChatSummary }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["invites", chat.id], queryFn: () => ctx.api.chats.invites(chat.id), enabled: open });
  const [expiry, setExpiry] = useState<keyof typeof INVITE_EXPIRY_OPTIONS>("never");
  const [limit, setLimit] = useState("");
  const [approval, setApproval] = useState(false);
  const linkFor = (token: string) => `${typeof window !== "undefined" && window.location.protocol.startsWith("http") ? window.location.origin : "https://veil.app"}/join/${token}`;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Invite links" wide>
      {chat.username && (
        <div className="mb-3 rounded-xl bg-surface p-3 text-sm">
          Public link: <b>{linkFor("@" + chat.username).replace("/join/@", "/")}</b>
        </div>
      )}
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {q.isLoading && <Spinner />}
        {q.data?.invites.map((l) => {
          const expired = (l.expiresAt && l.expiresAt < Date.now()) || (l.usageLimit > 0 && l.usageCount >= l.usageLimit);
          return (
            <div key={l.id} className={cn("flex items-center gap-3 rounded-xl bg-surface p-3", (l.revoked || expired) && "opacity-50")}>
              <Link2 className="h-5 w-5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{linkFor(l.token)}</div>
                <div className="text-[12px] text-muted">
                  {l.isPrimary ? "Primary · " : ""}
                  {l.usageCount} joined{l.usageLimit ? ` / ${l.usageLimit}` : ""}
                  {l.expiresAt ? ` · ${l.expiresAt < Date.now() ? "expired" : `expires ${new Date(l.expiresAt).toLocaleString()}`}` : ""}
                  {l.requiresApproval ? " · approval" : ""}
                  {l.revoked ? " · revoked" : ""}
                </div>
              </div>
              {!l.revoked && (
                <>
                  <IconButton label="Copy link" onClick={() => navigator.clipboard.writeText(linkFor(l.token)).then(() => toast("Link copied"))}>
                    <Copy className="h-4 w-4" />
                  </IconButton>
                  <IconButton label="Revoke" onClick={async () => (await ctx.api.chats.revokeInvite(chat.id, l.id), qc.invalidateQueries({ queryKey: ["invites", chat.id] }))}>
                    <Trash2 className="h-4 w-4 text-danger" />
                  </IconButton>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 space-y-3 rounded-2xl border border-border p-3">
        <div className="text-sm font-medium">Create a new link</div>
        <Segmented value={expiry} onChange={setExpiry} options={Object.keys(INVITE_EXPIRY_OPTIONS).map((k) => ({ value: k as keyof typeof INVITE_EXPIRY_OPTIONS, label: k === "never" ? "No expiry" : k }))} />
        <Input placeholder="Usage limit (optional)" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} />
        <label className="flex items-center justify-between text-[15px]">
          Request admin approval
          <Switch checked={approval} onCheckedChange={setApproval} />
        </label>
        <Button
          className="w-full"
          onClick={async () => {
            const l = await ctx.api.chats.createInvite(chat.id, { expiresIn: INVITE_EXPIRY_OPTIONS[expiry], usageLimit: Number(limit) || 0, requiresApproval: approval });
            await navigator.clipboard.writeText(linkFor(l.token)).catch(() => {});
            toast("Link created and copied");
            void qc.invalidateQueries({ queryKey: ["invites", chat.id] });
          }}
        >
          <Plus className="h-4 w-4" /> Create link
        </Button>
      </div>
    </Dialog>
  );
}

function RequestsDialog({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: ChatSummary }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["requests", chat.id], queryFn: () => ctx.api.chats.requests(chat.id), enabled: open });
  const decide = async (userId: string, approve: boolean) => {
    await ctx.api.chats.decideRequest(chat.id, userId, approve);
    void haptic(approve ? "success" : "light");
    void qc.invalidateQueries({ queryKey: ["requests", chat.id] });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Join requests">
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.requests.length ? (
        <p className="text-sm text-muted">No pending requests.</p>
      ) : (
        q.data.requests.map((r) => (
          <div key={r.userId} className="flex items-center gap-3 py-2">
            <Avatar id={r.userId} name={displayName(r.user)} mediaId={r.user.avatarMediaId} mediaKey={r.user.avatarKey} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{displayName(r.user)}</div>
              <div className="text-[12px] text-muted">{formatChatTime(r.createdAt)}</div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => decide(r.userId, false)}>Decline</Button>
            <Button size="sm" onClick={() => decide(r.userId, true)}>Approve</Button>
          </div>
        ))
      )}
    </Dialog>
  );
}

function PermissionsDialog({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: ChatSummary }) {
  const [perms, setPerms] = useState(chat.defaultPermissions);
  const [slow, setSlow] = useState(chat.slowModeSeconds);
  const [mode, setMode] = useState(chat.reactionsMode);
  const [allowed, setAllowed] = useState<string[]>(chat.allowedReactions.length ? chat.allowedReactions : DEFAULT_REACTIONS.slice(0, 6));
  useEffect(() => {
    if (open) {
      setPerms(chat.defaultPermissions);
      setSlow(chat.slowModeSeconds);
      setMode(chat.reactionsMode);
    }
  }, [open, chat]);
  const labels: Record<string, string> = { sendMessages: "Send messages", sendMedia: "Send media", sendPolls: "Send polls", addMembers: "Add members", pinMessages: "Pin messages", changeInfo: "Change group info" };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Permissions" wide>
      {chat.type === "group" && (
        <>
          <div className="mb-1 text-[13px] font-medium uppercase tracking-wide text-muted">What members can do</div>
          {MEMBER_PERMISSIONS.map((p) => (
            <label key={p} className="flex items-center justify-between rounded-xl px-2 py-2 text-[15px] hover:bg-surface">
              {labels[p]}
              <Switch checked={perms[p]} disabled={!chat.myRights.changeInfo} onCheckedChange={(v) => setPerms({ ...perms, [p]: v })} />
            </label>
          ))}
          <div className="mb-2 mt-4 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wide text-muted">
            <Clock className="h-4 w-4" /> Slow mode
          </div>
          <Segmented value={String(slow)} onChange={(v) => setSlow(Number(v))} options={SLOW_MODE_OPTIONS.map((s) => ({ value: String(s), label: s === 0 ? "Off" : s < 60 ? `${s}s` : `${s / 60}m` }))} />
        </>
      )}
      <div className="mb-2 mt-4 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wide text-muted">
        <Smile className="h-4 w-4" /> Reactions
      </div>
      <Segmented value={mode} onChange={setMode} options={[{ value: "all", label: "All" }, { value: "some", label: "Some" }, { value: "none", label: "None" }]} />
      {mode === "some" && (
        <div className="mt-2 flex flex-wrap gap-1">
          {DEFAULT_REACTIONS.map((e) => (
            <button key={e} onClick={() => setAllowed((a) => (a.includes(e) ? a.filter((x) => x !== e) : [...a, e]))} className={cn("h-10 w-10 rounded-xl text-xl", allowed.includes(e) ? "bg-accent-soft ring-2 ring-accent" : "bg-surface opacity-50")}>
              {e}
            </button>
          ))}
        </div>
      )}
      <Button
        className="mt-5 w-full"
        onClick={async () => {
          try {
            await ctx.api.chats.update(chat.id, {
              ...(chat.myRights.changeInfo && chat.type === "group" ? { defaultPermissions: perms } : {}),
              ...(chat.myRights.setSlowMode && chat.type === "group" ? { slowModeSeconds: slow } : {}),
              ...(chat.myRights.manageReactions ? { reactionsMode: mode, allowedReactions: mode === "some" ? allowed : [] } : {}),
            });
            await refreshServerChat(chat.id);
            toast("Saved");
            onClose();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      >
        Save
      </Button>
    </Dialog>
  );
}

function EditChatDialog({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: ChatSummary }) {
  const [title, setTitle] = useState(chat.title);
  const [description, setDescription] = useState(chat.description ?? "");
  const [isPublic, setPublic] = useState(chat.isPublic);
  const [username, setUsername] = useState(chat.username ?? "");
  const [signMessages, setSign] = useState(chat.signMessages);
  const [hideCount, setHideCount] = useState(chat.hideSubscriberCount);
  const [joinApproval, setJoinApproval] = useState(chat.joinApproval);
  const [busy, setBusy] = useState(false);
  const check = useUsernameCheck(isPublic ? username : "", chat.username);
  useEffect(() => {
    if (open) {
      setTitle(chat.title);
      setDescription(chat.description ?? "");
      setPublic(chat.isPublic);
      setUsername(chat.username ?? "");
    }
  }, [open, chat]);
  async function save() {
    setBusy(true);
    try {
      await ctx.api.chats.update(chat.id, {
        title,
        description,
        isPublic,
        username: isPublic ? username : null,
        joinApproval,
        ...(chat.type === "channel" ? { signMessages, hideSubscriberCount: hideCount } : {}),
      });
      await refreshServerChat(chat.id);
      toast("Saved");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={`Edit ${chat.type}`}>
      <div className="space-y-3">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name" maxLength={128} />
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" maxLength={255} />
        <label className="flex items-center justify-between text-[15px]">
          Public (discoverable by search)
          <Switch checked={isPublic} onCheckedChange={setPublic} />
        </label>
        {isPublic && (
          <div className="space-y-1">
            <Input leading={<AtSign className="h-4 w-4" />} value={username} onChange={(e) => setUsername(e.target.value.trim())} placeholder="public_link" />
            <UsernameHint state={check} />
          </div>
        )}
        <label className="flex items-center justify-between text-[15px]">
          Approve new members
          <Switch checked={joinApproval} onCheckedChange={setJoinApproval} />
        </label>
        {chat.type === "channel" && (
          <>
            <label className="flex items-center justify-between text-[15px]">
              Sign messages
              <Switch checked={signMessages} onCheckedChange={setSign} />
            </label>
            <label className="flex items-center justify-between text-[15px]">
              Hide subscriber count
              <Switch checked={hideCount} onCheckedChange={setHideCount} />
            </label>
          </>
        )}
        <Button className="w-full" loading={busy} onClick={save}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}

export function AddMembersDialog({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: () => ctx.api.contacts.list(), enabled: open });
  const search = useQuery({ queryKey: ["dir", q], queryFn: () => ctx.api.users.search(q), enabled: open && q.length >= 2 });
  const list = q.length >= 2 ? search.data?.users ?? [] : contacts.data?.contacts ?? [];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Add members">
      <Input placeholder="Search contacts or @username" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="my-2 max-h-72 overflow-y-auto">
        {list.map((u) => (
          <button key={u.id} onClick={() => setPicked((p) => { const n = new Map(p); if (n.has(u.id)) n.delete(u.id); else n.set(u.id, displayName(u)); return n; })} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface">
            <Avatar id={u.id} name={displayName(u)} mediaId={u.avatarMediaId} mediaKey={u.avatarKey} size={40} />
            <span className="flex-1 text-left">
              <span className="block text-[15px] font-medium">{displayName(u)}</span>
              <span className="block text-[13px] text-muted">{u.username ? `@${u.username}` : ""}</span>
            </span>
            <span className={cn("h-5 w-5 rounded-full border-2", picked.has(u.id) ? "border-accent bg-accent" : "border-subtle")} />
          </button>
        ))}
      </div>
      <Button
        className="w-full"
        disabled={!picked.size}
        onClick={async () => {
          const r = await ctx.api.chats.addMembers(chatId, [...picked.keys()]);
          toast(`Added ${r.added.length}${r.skipped.length ? ` · ${r.skipped.length} couldn't be added` : ""}`);
          setPicked(new Map());
          onClose();
        }}
      >
        Add {picked.size || ""}
      </Button>
    </Dialog>
  );
}

export function ChatInfoPanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const chat = useChat(chatId);
  const s = chat?.summary;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { openChat } = useUI();
  const [memberQ, setMemberQ] = useState("");
  const [dlg, setDlg] = useState<null | "invites" | "requests" | "perms" | "edit" | "add">(null);
  const [tab, setTab] = useState<"members" | "media">("members");
  const isAdmin = s?.myRole === "owner" || s?.myRole === "admin";
  const members = useQuery({
    queryKey: ["members", chatId, memberQ],
    queryFn: () => ctx.api.chats.members(chatId, { q: memberQ || undefined, limit: 200 }),
    enabled: !!s && (s.type === "group" || isAdmin),
  });
  const requests = useQuery({ queryKey: ["requests", chatId], queryFn: () => ctx.api.chats.requests(chatId), enabled: !!s?.myRights?.inviteUsers });
  if (!chat) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const muted = (chat.mutedUntil ?? 0) > Date.now();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["members", chatId] });
    void refreshServerChat(chatId);
  };

  async function changeAvatar(f: File) {
    const img = await prepareAvatar(f);
    const up = await uploadEncrypted(img);
    await ctx.api.chats.update(chatId, { avatarMediaId: up.mediaId, avatarKey: up.key });
    await refreshServerChat(chatId);
    toast("Photo updated");
  }

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <PanelHeader title={chat.type === "channel" ? "Channel info" : "Group info"} onClose={onClose} />
      <div className="flex flex-col items-center px-6 pb-4 pt-6 text-center">
        <label className={cn("relative", s?.myRights?.changeInfo && "cursor-pointer")}>
          <ChatAvatar chat={chat} size={112} />
          {s?.myRights?.changeInfo && (
            <>
              <span className="absolute bottom-1 right-1 flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white shadow-soft">
                <Camera className="h-4 w-4" />
              </span>
              <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void changeAvatar(e.target.files[0]).catch((er) => toast.error(er.message))} />
            </>
          )}
        </label>
        <h2 className="mt-3 text-[22px] font-semibold">{chat.title}</h2>
        <p className="text-[14px] text-muted">
          {s ? (s.memberCount >= 0 ? plural(s.memberCount, chat.type === "channel" ? "subscriber" : "member") : chat.type) : ""}
          {s?.isPublic ? " · public" : " · private"}
        </p>
        <p className="mt-1 flex items-center gap-1 text-[12px] text-subtle">
          <Lock className="h-3 w-3" /> End-to-end encrypted · key epoch {s?.keyEpoch ?? 0}
        </p>
      </div>
      <div className="flex gap-2 px-4 pb-5">
        <ActionButton icon={muted ? Bell : BellOff} label={muted ? "Unmute" : "Mute"} onClick={() => void muteChat(chatId, muted ? null : Number.MAX_SAFE_INTEGER)} />
        {chat.type === "group" && s?.myRole && <ActionButton icon={Phone} label="Call" onClick={() => void startCall({ chatId }, false, chat.title ?? "Group").catch((e) => toast.error(e.message))} />}
        {(s?.myRights?.inviteUsers || (chat.type === "group" && s?.defaultPermissions.addMembers)) && <ActionButton icon={UserPlus} label="Add" onClick={() => setDlg("add")} />}
        {s?.myRole ? (
          <ActionButton
            icon={LogOut}
            label="Leave"
            danger
            onClick={async () => {
              const r = await confirm({ title: `Leave ${chat.title}?`, confirm: "Leave", danger: true });
              if (r.ok) {
                await ctx.api.chats.leave(chatId);
                openChat(null);
                onClose();
              }
            }}
          />
        ) : (
          <ActionButton icon={Plus} label="Join" onClick={() => void ctx.api.chats.join(chatId).then(refresh)} />
        )}
      </div>
      <div className="px-3">
        <Section>
          {s?.description && <Row icon={<InfoIcon className="h-5 w-5" />} title={<RichText text={s.description} />} subtitle="Description" />}
          {s?.username && <Row icon={<AtSign className="h-5 w-5" />} title={`@${s.username}`} subtitle="Public link" onClick={() => navigator.clipboard.writeText(`@${s.username}`).then(() => toast("Copied"))} />}
        </Section>
        {isAdmin && s && (
          <Section title="Manage">
            {s.myRights.changeInfo && <Row icon={<SlidersHorizontal className="h-5 w-5" />} title="Edit info" onClick={() => setDlg("edit")} trailing={<ChevronRight className="h-4 w-4 text-subtle" />} />}
            {s.myRights.inviteUsers && <Row icon={<Link2 className="h-5 w-5" />} title="Invite links" onClick={() => setDlg("invites")} trailing={<ChevronRight className="h-4 w-4 text-subtle" />} />}
            {s.myRights.inviteUsers && (
              <Row icon={<Users className="h-5 w-5" />} title="Join requests" onClick={() => setDlg("requests")} trailing={<span className="text-sm text-muted">{requests.data?.requests.length ?? 0}</span>} />
            )}
            <Row icon={<Shield className="h-5 w-5" />} title="Permissions, slow mode & reactions" onClick={() => setDlg("perms")} trailing={<ChevronRight className="h-4 w-4 text-subtle" />} />
            {s.myRole === "owner" && (
              <Row
                icon={<Trash2 className="h-5 w-5" />}
                title={`Delete ${chat.type}`}
                danger
                onClick={async () => {
                  const r = await confirm({ title: `Delete ${chat.title} for everyone?`, body: "This can't be undone.", confirm: "Delete", danger: true });
                  if (r.ok) {
                    await ctx.api.chats.remove(chatId);
                    openChat(null);
                    onClose();
                  }
                }}
              />
            )}
          </Section>
        )}
        <div className="mb-2">
          <Segmented value={tab} onChange={setTab} options={[{ value: "members", label: chat.type === "channel" ? "Subscribers" : "Members" }, { value: "media", label: "Shared media" }]} />
        </div>
      </div>
      {tab === "members" ? (
        chat.type === "channel" && !isAdmin ? (
          <p className="p-6 text-center text-sm text-muted">Only admins can see the subscriber list.</p>
        ) : (
          <>
            <div className="px-3 pb-2">
              <Input placeholder="Search members" value={memberQ} onChange={(e) => setMemberQ(e.target.value)} />
            </div>
            {members.isLoading ? <div className="flex justify-center p-4"><Spinner /></div> : members.data?.members.map((m) => <MemberRow key={m.userId} m={m} chat={s!} onChanged={refresh} />)}
          </>
        )
      ) : (
        <SharedMedia chatId={chatId} />
      )}
      <div className="h-10" />
      {s && (
        <>
          <InviteLinksDialog open={dlg === "invites"} onClose={() => setDlg(null)} chat={s} />
          <RequestsDialog open={dlg === "requests"} onClose={() => (setDlg(null), void qc.invalidateQueries({ queryKey: ["requests", chatId] }))} chat={s} />
          <PermissionsDialog open={dlg === "perms"} onClose={() => setDlg(null)} chat={s} />
          <EditChatDialog open={dlg === "edit"} onClose={() => setDlg(null)} chat={s} />
          <AddMembersDialog open={dlg === "add"} onClose={() => (setDlg(null), refresh())} chatId={chatId} />
        </>
      )}
    </div>
  );
}

