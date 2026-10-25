"use client";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Calendar, Camera, Contact, File as FileIcon, Flame, Image as ImageIcon, MapPin, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_FILE_SIZE, MAX_POLL_OPTIONS, ONCE_VIEW_TTLS, formatBytes } from "@veil/shared";
import { ctx, displayName, kindFor, sendFile, sendMessage } from "../engine";
import { getCurrentPosition, haptic } from "../lib/native";
import { isNative } from "../lib/platform";
import type { LocalChat, StoredMessage } from "../lib/types";
import { cn } from "../lib/cn";
import { StaticMap } from "./content";
import { Dialog, Sheet } from "./overlays";
import { Button, Input, Segmented, Spinner, Switch, Textarea } from "./primitives";
import { Avatar } from "./avatar";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  chat: LocalChat;
  replyTo: StoredMessage | null;
  onSent: () => void;
}

export function AttachmentSheet({ open, onOpenChange, chat, replyTo, onSent }: Props) {
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ files: File[]; asDocument: boolean } | null>(null);
  const [dialog, setDialog] = useState<"poll" | "event" | "location" | "contact" | null>(null);
  const canPoll = chat.type !== "group" || chat.summary?.myRole !== "member" || chat.summary?.defaultPermissions?.sendPolls !== false;

  const pick = (ref: React.RefObject<HTMLInputElement | null>) => () => {
    void haptic("light");
    ref.current?.click();
  };

  async function takePhotoNative() {
    const { Camera: Cam, CameraResultType, CameraSource } = await import("@capacitor/camera");
    const p = await Cam.getPhoto({ resultType: CameraResultType.Uri, source: CameraSource.Camera, quality: 90 });
    const blob = await (await fetch(p.webPath!)).blob();
    setPending({ files: [new File([blob], `photo-${Date.now()}.${p.format}`, { type: blob.type || `image/${p.format}` })], asDocument: false });
    onOpenChange(false);
  }

  const tiles = [
    { label: "Gallery", icon: ImageIcon, color: "from-[#2AABEE] to-[#5B7CFA]", on: pick(gallery) },
    { label: "Camera", icon: Camera, color: "from-[#7C5CFF] to-[#C56CF0]", on: isNative() ? () => void takePhotoNative().catch(() => {}) : pick(camera) },
    { label: "File", icon: FileIcon, color: "from-[#00A88E] to-[#22C55E]", on: pick(files) },
    { label: "Location", icon: MapPin, color: "from-[#22C55E] to-[#00A88E]", on: () => (onOpenChange(false), setDialog("location")) },
    { label: "Contact", icon: Contact, color: "from-[#F5A524] to-[#FF7A59]", on: () => (onOpenChange(false), setDialog("contact")) },
    { label: "Poll", icon: BarChart3, color: "from-[#FF7A59] to-[#FF4D8D]", on: () => (onOpenChange(false), setDialog("poll")), hidden: !canPoll },
    { label: "Event", icon: Calendar, color: "from-[#EC4899] to-[#8B5CF6]", on: () => (onOpenChange(false), setDialog("event")) },
  ].filter((t) => !t.hidden);

  const onFiles = (asDocument: boolean) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = [...(e.target.files ?? [])];
    e.target.value = "";
    if (!list.length) return;
    const tooBig = list.find((f) => f.size > MAX_FILE_SIZE);
    if (tooBig) return toast.error(`${tooBig.name} is larger than 2 GB`);
    setPending({ files: list, asDocument });
    onOpenChange(false);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title="Share">
        <div className="grid grid-cols-4 gap-4 px-5 pb-6 pt-2">
          {tiles.map((t) => (
            <button key={t.label} onClick={t.on} className="flex flex-col items-center gap-2 active:scale-95">
              <span className={cn("flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-soft", t.color)}>
                <t.icon className="h-6 w-6" />
              </span>
              <span className="text-[13px] text-muted">{t.label}</span>
            </button>
          ))}
        </div>
      </Sheet>
      <input ref={gallery} type="file" accept="image/*,video/*" multiple hidden onChange={onFiles(false)} />
      <input ref={camera} type="file" accept="image/*,video/*" capture="environment" hidden onChange={onFiles(false)} />
      <input ref={files} type="file" multiple hidden onChange={onFiles(true)} />

      <SendMediaDialog pending={pending} onClose={() => setPending(null)} chat={chat} replyTo={replyTo} onSent={onSent} />
      <PollComposer open={dialog === "poll"} onClose={() => setDialog(null)} chat={chat} />
      <EventComposer open={dialog === "event"} onClose={() => setDialog(null)} chat={chat} />
      <LocationComposer open={dialog === "location"} onClose={() => setDialog(null)} chat={chat} />
      <ContactComposer open={dialog === "contact"} onClose={() => setDialog(null)} chat={chat} />
    </>
  );
}

function SendMediaDialog({ pending, onClose, chat, replyTo, onSent }: { pending: { files: File[]; asDocument: boolean } | null; onClose: () => void; chat: LocalChat; replyTo: StoredMessage | null; onSent: () => void }) {
  const [caption, setCaption] = useState("");
  const [asDocument, setAsDocument] = useState(false);
  const [once, setOnce] = useState(false);
  const [ttl, setTtl] = useState<keyof typeof ONCE_VIEW_TTLS>("30s");
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    if (!pending) return;
    setCaption("");
    setOnce(false);
    setAsDocument(pending.asDocument);
    const urls = pending.files.map((f) => (f.type.startsWith("image/") || f.type.startsWith("video/") ? URL.createObjectURL(f) : ""));
    setPreviews(urls);
    return () => urls.forEach((u) => u && URL.revokeObjectURL(u));
  }, [pending]);
  if (!pending) return null;
  const single = pending.files.length === 1;
  const visual = pending.files.every((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
  const allowOnce = single && visual && !asDocument && chat.type !== "channel";

  async function send() {
    const list = pending!.files;
    onClose();
    void haptic("light");
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      void sendFile(chat.id, f, {
        asDocument,
        caption: i === list.length - 1 ? caption.trim() || undefined : undefined,
        onceViewTtl: allowOnce && once ? ONCE_VIEW_TTLS[ttl] : undefined,
        replyTo: i === 0 ? replyTo ?? undefined : undefined,
      }).catch((e) => toast.error(`${f.name}: ${(e as Error).message}`));
    }
    onSent();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={single ? (asDocument ? "Send file" : `Send ${kindFor(pending.files[0], false)}`) : `Send ${pending.files.length} items`}>
      <div className="mb-3 grid max-h-72 grid-cols-3 gap-1.5 overflow-y-auto">
        {pending.files.map((f, i) =>
          !asDocument && previews[i] ? (
            f.type.startsWith("video/") ? (
              <video key={i} src={previews[i]} className={cn("aspect-square w-full rounded-xl object-cover", single && "col-span-3 aspect-auto max-h-72", once && "blur-md")} muted />
            ) : (
              <img key={i} src={previews[i]} alt="" className={cn("aspect-square w-full rounded-xl object-cover", single && "col-span-3 aspect-auto max-h-72 object-contain", once && "blur-md")} />
            )
          ) : (
            <div key={i} className="col-span-3 flex items-center gap-3 rounded-xl bg-surface p-3">
              <FileIcon className="h-8 w-8 text-accent" />
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium">{f.name}</div>
                <div className="text-[13px] text-muted">{formatBytes(f.size)}</div>
              </div>
            </div>
          ),
        )}
      </div>
      <Textarea rows={2} placeholder="Add a caption…" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={1024} />
      {visual && (
        <label className="mt-3 flex items-center justify-between text-[15px]">
          Send as file (no compression)
          <Switch checked={asDocument} onCheckedChange={setAsDocument} />
        </label>
      )}
      {allowOnce && (
        <div className="mt-3 rounded-xl bg-surface p-3">
          <label className="flex items-center justify-between text-[15px]">
            <span className="flex items-center gap-2">
              <Flame className="h-4 w-4 text-[#FF4D8D]" /> Once-view
            </span>
            <Switch checked={once} onCheckedChange={setOnce} />
          </label>
          {once && (
            <div className="mt-3">
              <p className="mb-2 text-[13px] text-muted">Destroyed after it's opened, or automatically after:</p>
              <Segmented value={ttl} onChange={setTtl} options={Object.keys(ONCE_VIEW_TTLS).map((k) => ({ value: k as keyof typeof ONCE_VIEW_TTLS, label: k }))} />
            </div>
          )}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={send}>Send</Button>
      </div>
    </Dialog>
  );
}

function PollComposer({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: LocalChat }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState(["", ""]);
  const [anonymous, setAnonymous] = useState(true);
  const [multiple, setMultiple] = useState(false);
  const [quiz, setQuiz] = useState(false);
  const [correct, setCorrect] = useState(0);
  const [explanation, setExplanation] = useState("");
  useEffect(() => {
    if (open) {
      setQ("");
      setOpts(["", ""]);
      setQuiz(false);
      setCorrect(0);
      setExplanation("");
    }
  }, [open]);
  const valid = q.trim() && opts.filter((o) => o.trim()).length >= 2;
  async function send() {
    const options = opts.map((t) => t.trim()).filter(Boolean).map((text) => ({ id: crypto.randomUUID().slice(0, 8), text }));
    onClose();
    await sendMessage(chat.id, {
      t: "poll",
      question: q.trim(),
      options,
      anonymous,
      multiple: quiz ? false : multiple,
      quiz: quiz ? { correctOptionId: options[Math.min(correct, options.length - 1)].id, explanation: explanation.trim() || undefined } : undefined,
    });
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="New poll">
      <div className="space-y-3">
        <Input placeholder="Ask a question" value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} />
        <div className="space-y-2">
          {opts.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              {quiz && <input type="radio" name="correct" checked={correct === i} onChange={() => setCorrect(i)} className="h-5 w-5 accent-[var(--accent)]" aria-label="Correct answer" />}
              <Input className="flex-1" placeholder={`Option ${i + 1}`} value={o} maxLength={100} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} />
              {opts.length > 2 && (
                <button onClick={() => setOpts(opts.filter((_, j) => j !== i))} className="text-muted" aria-label="Remove option">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {opts.length < MAX_POLL_OPTIONS && (
            <button onClick={() => setOpts([...opts, ""])} className="flex items-center gap-1 text-sm font-medium text-accent">
              <Plus className="h-4 w-4" /> Add option
            </button>
          )}
        </div>
        <div className="space-y-2 rounded-xl bg-surface p-3 text-[15px]">
          <label className="flex items-center justify-between">Anonymous voting <Switch checked={anonymous} onCheckedChange={setAnonymous} /></label>
          <label className="flex items-center justify-between">Multiple answers <Switch checked={multiple && !quiz} disabled={quiz} onCheckedChange={setMultiple} /></label>
          <label className="flex items-center justify-between">Quiz mode <Switch checked={quiz} onCheckedChange={setQuiz} /></label>
        </div>
        {quiz && <Input placeholder="Explanation (optional)" value={explanation} onChange={(e) => setExplanation(e.target.value)} maxLength={200} />}
        <Button className="w-full" disabled={!valid} onClick={send}>
          Create poll
        </Button>
      </div>
    </Dialog>
  );
}

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function EventComposer({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: LocalChat }) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 86400000)));
  const [end, setEnd] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  async function send() {
    const startsAt = new Date(start).getTime();
    const endsAt = end ? new Date(end).getTime() : undefined;
    if (endsAt && endsAt < startsAt) return toast.error("End time must be after the start");
    onClose();
    await sendMessage(chat.id, { t: "event", title: title.trim(), startsAt, endsAt, location: location.trim() || undefined, description: description.trim() || undefined });
    setTitle("");
    setLocation("");
    setDescription("");
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="New event">
      <div className="space-y-3">
        <Input placeholder="Event title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <label className="block text-sm text-muted">
          Starts
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 h-11 w-full rounded-xl bg-surface px-3 text-text outline-none" />
        </label>
        <label className="block text-sm text-muted">
          Ends (optional)
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 h-11 w-full rounded-xl bg-surface px-3 text-text outline-none" />
        </label>
        <Input placeholder="Location (optional)" value={location} onChange={(e) => setLocation(e.target.value)} leading={<MapPin className="h-4 w-4" />} />
        <Textarea rows={3} placeholder="Details (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        <Button className="w-full" disabled={!title.trim() || !start} onClick={send}>
          Share event
        </Button>
      </div>
    </Dialog>
  );
}

function LocationComposer({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: LocalChat }) {
  const [pos, setPos] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setPos(null);
    setError(null);
    getCurrentPosition()
      .then(setPos)
      .catch((e) => setError(e.message));
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Share location">
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !pos ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl">
            <StaticMap lat={pos.lat} lng={pos.lng} width={400} height={200} />
          </div>
          <p className="text-[13px] text-muted">Accurate to {Math.round(pos.accuracy)} m</p>
          <Input placeholder="Label (optional) — e.g. Café Central" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
          <Button
            className="w-full"
            onClick={() => {
              onClose();
              void sendMessage(chat.id, { t: "location", lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, label: label.trim() || undefined });
            }}
          >
            <MapPin className="h-4 w-4" /> Send my current location
          </Button>
        </div>
      )}
    </Dialog>
  );
}

function ContactComposer({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: LocalChat }) {
  const { data, isLoading } = useQuery({ queryKey: ["contacts"], queryFn: () => ctx.api.contacts.list(), enabled: open });
  const [q, setQ] = useState("");
  const list = (data?.contacts ?? []).filter((u) => displayName(u).toLowerCase().includes(q.toLowerCase()) || u.username?.includes(q.toLowerCase()));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Share contact">
      <Input placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} className="mb-2" />
      <div className="max-h-80 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : list.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted">No contacts</p>
        ) : (
          list.map((u) => (
            <button
              key={u.id}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface"
              onClick={() => {
                onClose();
                void sendMessage(chat.id, { t: "contact", name: displayName(u), userId: u.id, username: u.username ?? undefined, phone: u.phoneNumber ?? undefined });
              }}
            >
              <Avatar id={u.id} name={displayName(u)} mediaId={u.avatarMediaId} mediaKey={u.avatarKey} size={40} />
              <div className="text-left">
                <div className="text-[15px] font-medium">{displayName(u)}</div>
                <div className="text-[13px] text-muted">{u.username ? `@${u.username}` : u.phoneNumber}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
