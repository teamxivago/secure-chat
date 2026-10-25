"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  AtSign,
  Bell,
  Camera,
  ChevronLeft,
  ChevronRight,
  Database,
  Eye,
  Fingerprint,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  QrCode,
  Shield,
  Smartphone,
  Sticker,
  Sun,
  Trash2,
  UserX,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { BIO_MAX, LOCK_TIMEOUTS, USERNAME_COOLDOWN_MS, type Visibility } from "@veil/shared";
import { fromB64 } from "@veil/crypto";
import {
  approveLink,
  approveLinkFromUri,
  createRecoveryKey,
  ctx,
  displayName,
  getLockSettings,
  hashPin,
  refreshMe,
  saveLockSettings,
  setBlocked,
  signOut,
  updateSettings,
  uploadEncrypted,
  type AutoMode,
  type LockSettings,
} from "../engine";
import { useMe, useSettings, useBus } from "../hooks";
import { cn } from "../lib/cn";
import { formatChatTime } from "../lib/format";
import { biometricAvailable, haptic } from "../lib/native";
import { useUI } from "../store/ui";
import { Avatar } from "../components/avatar";
import { Dialog, useConfirm } from "../components/overlays";
import { Button, IconButton, Input, Row, Section, Segmented, Spinner, Switch, Textarea } from "../components/primitives";
import { QrScanner } from "../components/qr-scanner";
import { prepareAvatar, useUsernameCheck, UsernameHint } from "./auth";
import { PinPad } from "./lock";

function Page({ title, children }: { title: string; children: ReactNode }) {
  const set = useUI((s) => s.set);
  return (
    <div className="flex h-full flex-col">
      <header className="safe-top flex h-14 shrink-0 items-center gap-2 px-2">
        <IconButton label="Back" onClick={() => set({ settingsPage: null })}>
          <ChevronLeft className="h-6 w-6" />
        </IconButton>
        <h1 className="text-[19px] font-semibold">{title}</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-3 pb-24 pt-2">{children}</div>
    </div>
  );
}

const go = (page: string) => () => useUI.getState().set({ settingsPage: page });
const chevron = <ChevronRight className="h-4 w-4 text-subtle" />;

/* ------------------------------ main ------------------------------ */

export function SettingsScreen() {
  const page = useUI((s) => s.settingsPage);
  const me = useMe();
  const confirm = useConfirm();
  switch (page) {
    case "profile":
      return <ProfilePage />;
    case "privacy":
      return <PrivacyPage />;
    case "devices":
      return <DevicesPage />;
    case "notifications":
      return <NotificationsPage />;
    case "appearance":
      return <AppearancePage />;
    case "data":
      return <DataPage />;
    case "stickers":
      return <StickersPage />;
  }
  if (!me) return null;
  return (
    <div className="flex h-full flex-col">
      <header className="safe-top flex h-14 shrink-0 items-center px-4">
        <h1 className="text-[26px] font-bold tracking-tight">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-3 pb-24 pt-2">
        <button onClick={go("profile")} className="mb-5 flex w-full items-center gap-4 rounded-2xl bg-elevated p-4 text-left shadow-soft ring-1 ring-border">
          <Avatar id={me.id} name={displayName(me)} mediaId={me.avatarMediaId} mediaKey={me.avatarKey} size={64} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[19px] font-semibold">
              {displayName(me)} {me.emojiStatus}
            </div>
            <div className="truncate text-[14px] text-muted">{[me.phoneNumber, me.username && `@${me.username}`].filter(Boolean).join(" · ") || me.email}</div>
          </div>
          {chevron}
        </button>
        <Section>
          <Row icon={<Shield className="h-5 w-5" />} title="Privacy and Security" onClick={go("privacy")} trailing={chevron} />
          <Row icon={<Laptop className="h-5 w-5" />} title="Devices" onClick={go("devices")} trailing={chevron} />
          <Row icon={<Bell className="h-5 w-5" />} title="Notifications and Sounds" onClick={go("notifications")} trailing={chevron} />
        </Section>
        <Section>
          <Row icon={<Palette className="h-5 w-5" />} title="Appearance" onClick={go("appearance")} trailing={chevron} />
          <Row icon={<Database className="h-5 w-5" />} title="Data and Storage" onClick={go("data")} trailing={chevron} />
          <Row icon={<Sticker className="h-5 w-5" />} title="Stickers" onClick={go("stickers")} trailing={chevron} />
        </Section>
        <Section>
          <Row
            icon={<LogOut className="h-5 w-5" />}
            title="Log out"
            danger
            onClick={async () => {
              const r = await confirm({ title: "Log out of Veil?", body: "This device's keys and local messages will be wiped. Your history stays available on your other devices.", confirm: "Log out", danger: true });
              if (r.ok) await signOut();
            }}
          />
        </Section>
        <p className="mt-6 text-center text-xs text-subtle">
          Veil · Signal Protocol (X3DH, Double Ratchet, Sender Keys) · Sealed Sender
          <br />
          Device {ctx.account?.deviceId}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------ profile ------------------------------ */

const STATUS_EMOJI = ["", "😎", "🔥", "💼", "🎧", "✈️", "🏖️", "🤒", "🎮", "📚", "💤", "🚀", "❤️", "⭐"];

function ProfilePage() {
  const me = useMe()!;
  const [name, setName] = useState(me.name);
  const [lastName, setLastName] = useState(me.lastName ?? "");
  const [username, setUsername] = useState(me.username ?? "");
  const [bio, setBio] = useState(me.bio ?? "");
  const [emoji, setEmoji] = useState(me.emojiStatus ?? "");
  const [busy, setBusy] = useState(false);
  const check = useUsernameCheck(username, me.username);
  const cooldownUntil = me.usernameChangedAt ? me.usernameChangedAt + USERNAME_COOLDOWN_MS : 0;
  const locked = !!me.username && cooldownUntil > Date.now();

  async function save() {
    setBusy(true);
    try {
      await ctx.api.me.update({
        name: name.trim(),
        lastName: lastName.trim(),
        bio,
        emojiStatus: emoji || null,
        ...(username && username !== me.username ? { username } : {}),
      });
      await refreshMe();
      toast("Profile saved");
      void haptic("success");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function avatar(f: File) {
    const img = await prepareAvatar(f);
    const up = await uploadEncrypted(img);
    await ctx.api.me.update({ avatarMediaId: up.mediaId, avatarKey: up.key });
    await refreshMe();
    toast("Photo updated");
  }

  return (
    <Page title="Edit profile">
      <div className="mb-5 flex flex-col items-center">
        <label className="relative cursor-pointer">
          <Avatar id={me.id} name={displayName(me)} mediaId={me.avatarMediaId} mediaKey={me.avatarKey} size={104} />
          <span className="absolute bottom-0 right-0 flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white shadow-soft">
            <Camera className="h-4 w-4" />
          </span>
          <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void avatar(e.target.files[0]).catch((er) => toast.error(er.message))} />
        </label>
        {me.avatarMediaId && (
          <button className="mt-2 text-sm text-danger" onClick={() => ctx.api.me.update({ avatarMediaId: null, avatarKey: null }).then(refreshMe)}>
            Remove photo
          </button>
        )}
      </div>
      <div className="space-y-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="First name" maxLength={64} />
        <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" maxLength={64} />
        <div className="space-y-1">
          <Input leading={<AtSign className="h-4 w-4" />} value={username} disabled={locked} onChange={(e) => setUsername(e.target.value.trim())} placeholder="username" />
          {locked ? <p className="px-1 text-xs text-muted">You can change your username again on {new Date(cooldownUntil).toLocaleDateString()}.</p> : <UsernameHint state={check} />}
        </div>
        <div>
          <Textarea rows={2} value={bio} maxLength={BIO_MAX} onChange={(e) => setBio(e.target.value)} placeholder="Bio" />
          <p className="px-1 text-right text-xs text-muted">{BIO_MAX - bio.length}</p>
        </div>
        <div>
          <p className="mb-1 px-1 text-[13px] text-muted">Emoji status</p>
          <div className="flex flex-wrap gap-1">
            {STATUS_EMOJI.map((e) => (
              <button key={e || "none"} onClick={() => setEmoji(e)} className={cn("flex h-10 w-10 items-center justify-center rounded-xl text-xl", emoji === e ? "bg-accent-soft ring-2 ring-accent" : "bg-surface")}>
                {e || "∅"}
              </button>
            ))}
          </div>
        </div>
        <Section>
          {me.phoneNumber && <Row icon={<Smartphone className="h-5 w-5" />} title={me.phoneNumber} subtitle="Phone" />}
          {me.email && <Row icon={<MessageSquare className="h-5 w-5" />} title={me.email} subtitle="Email" />}
        </Section>
        <Button className="w-full" loading={busy} onClick={save} disabled={username !== (me.username ?? "") && username !== "" && check !== "available"}>
          Save
        </Button>
      </div>
    </Page>
  );
}

/* ------------------------------ privacy & security ------------------------------ */

const VIS: { value: Visibility; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "contacts", label: "Contacts" },
  { value: "nobody", label: "Nobody" },
];

function PrivacyPage() {
  const me = useMe()!;
  const settings = useSettings();
  const qc = useQueryClient();
  const [lock, setLock] = useState<LockSettings>(getLockSettings());
  const [pinSetup, setPinSetup] = useState<null | "new" | "confirm">(null);
  const [firstPin, setFirstPin] = useState("");
  const [bio, setBio] = useState<{ available: boolean; label: string }>({ available: false, label: "" });
  const [recovery, setRecovery] = useState<string | null>(null);
  const blocked = useQuery({ queryKey: ["blocked"], queryFn: async () => (await (await import("../lib/db")).kvGet<string[]>("blocked")) ?? [] });
  useEffect(() => void biometricAvailable().then(setBio), []);

  const updatePrivacy = async (p: Record<string, unknown>) => {
    await ctx.api.me.update({ privacy: p });
    await refreshMe();
    void haptic("light");
  };
  const saveLock = (s: LockSettings) => {
    saveLockSettings(s);
    setLock(s);
  };

  return (
    <Page title="Privacy and Security">
      <Section title="Privacy">
        {(
          [
            ["lastSeenVisibility", "Last seen & online"],
            ["phoneVisibility", "Phone number"],
            ["profilePhotoVisibility", "Profile photo"],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="space-y-2 px-4 py-3 [&+&]:border-t [&+&]:border-border">
            <div className="text-[15px]">{label}</div>
            <Segmented value={me.privacy[k]} onChange={(v) => void updatePrivacy({ [k]: v })} options={VIS} />
          </div>
        ))}
        <Row icon={<Eye className="h-5 w-5" />} title="Find me by phone number" trailing={<Switch checked={me.privacy.phoneDiscoverable} onCheckedChange={(v) => void updatePrivacy({ phoneDiscoverable: v })} />} />
        <Row icon={<MessageSquare className="h-5 w-5" />} title="Read receipts" subtitle="If off, you won't see others' either" trailing={settings && <Switch checked={settings.readReceipts} onCheckedChange={(v) => void updateSettings({ readReceipts: v })} />} />
      </Section>

      <Section title="App lock" footer="When enabled, Veil asks for your PIN or biometrics every time it opens or returns from the background.">
        <Row
          icon={<Lock className="h-5 w-5" />}
          title="Passcode lock"
          trailing={
            <Switch
              label="Passcode lock"
              checked={lock.enabled}
              onCheckedChange={(v) => {
                if (v) setPinSetup("new");
                else saveLock({ enabled: false, method: "pin", timeoutSec: 0 });
              }}
            />
          }
        />
        {lock.enabled && (
          <>
            <Row icon={<KeyRound className="h-5 w-5" />} title="Change passcode" onClick={() => setPinSetup("new")} trailing={chevron} />
            {bio.available && (
              <Row
                icon={<Fingerprint className="h-5 w-5" />}
                title={`Unlock with ${bio.label}`}
                subtitle="Falls back to passcode after 3 failed attempts"
                trailing={<Switch checked={lock.method !== "pin"} onCheckedChange={(v) => saveLock({ ...lock, method: v ? "both" : "pin" })} />}
              />
            )}
            <div className="space-y-2 border-t border-border px-4 py-3">
              <div className="text-[15px]">Auto-lock</div>
              <Segmented
                value={String(lock.timeoutSec)}
                onChange={(v) => saveLock({ ...lock, timeoutSec: Number(v) })}
                options={Object.entries(LOCK_TIMEOUTS).map(([k, v]) => ({ value: String(v), label: k === "immediate" ? "Now" : k }))}
              />
            </div>
          </>
        )}
      </Section>

      <Section title="Encryption" footer="The recovery key restores your encrypted history if you lose all your devices. Store it offline — Veil can't recover it for you.">
        <Row
          icon={<KeyRound className="h-5 w-5" />}
          title={me.hasAccountKeyBackup ? "Rotate recovery key" : "Set up recovery key"}
          onClick={async () => {
            try {
              setRecovery("…");
              setRecovery(await createRecoveryKey());
              await refreshMe();
            } catch (e) {
              setRecovery(null);
              toast.error((e as Error).message);
            }
          }}
          trailing={chevron}
        />
        <Row icon={<Shield className="h-5 w-5" />} title="Screen security" subtitle="Screenshots and screen recording are blocked in the mobile apps" />
      </Section>

      <Section title={`Blocked users${blocked.data?.length ? ` · ${blocked.data.length}` : ""}`}>
        {!blocked.data?.length ? (
          <Row icon={<UserX className="h-5 w-5" />} title="No blocked users" />
        ) : (
          blocked.data.map((id) => <BlockedRow key={id} id={id} onDone={() => qc.invalidateQueries({ queryKey: ["blocked"] })} />)
        )}
      </Section>

      <Dialog open={!!pinSetup} onOpenChange={(o) => !o && setPinSetup(null)} title={pinSetup === "confirm" ? "Repeat passcode" : "Create a passcode"}>
        <PinPad
          key={pinSetup ?? "closed"}
          length={pinSetup === "confirm" ? firstPin.length : undefined}
          variable={pinSetup === "new"}
          onComplete={async (pin) => {
            if (pinSetup === "new") {
              setFirstPin(pin);
              setPinSetup("confirm");
              return true;
            }
            if (pin !== firstPin) {
              toast.error("Passcodes don't match");
              setPinSetup("new");
              return false;
            }
            const { hash, salt } = await hashPin(pin);
            saveLock({ ...lock, enabled: true, pinHash: hash, pinSalt: salt, pinLength: pin.length, method: lock.method ?? "pin", timeoutSec: lock.timeoutSec ?? 0, failedAttempts: 0 });
            setPinSetup(null);
            toast("Passcode set");
            return true;
          }}
        />
      </Dialog>

      <Dialog open={!!recovery} onOpenChange={(o) => !o && setRecovery(null)} title="Your recovery key" description="Write it down or save it in a password manager. It's shown only once.">
        {recovery === "…" ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2 rounded-2xl bg-surface p-4 text-center font-mono text-[15px] tracking-wider">
              {recovery?.split("-").map((g, i) => <span key={i}>{g}</span>)}
            </div>
            <Button className="mt-4 w-full" variant="secondary" onClick={() => navigator.clipboard.writeText(recovery ?? "").then(() => toast("Copied"))}>
              Copy
            </Button>
            <Button className="mt-2 w-full" onClick={() => setRecovery(null)}>
              I saved it
            </Button>
          </>
        )}
      </Dialog>
    </Page>
  );
}

function BlockedRow({ id, onDone }: { id: string; onDone: () => void }) {
  const q = useQuery({ queryKey: ["user", id], queryFn: () => ctx.api.users.get(id) });
  return (
    <Row
      icon={<Avatar id={id} name={displayName(q.data)} mediaId={q.data?.avatarMediaId} mediaKey={q.data?.avatarKey} size={32} />}
      title={displayName(q.data)}
      trailing={
        <Button size="sm" variant="secondary" onClick={() => setBlocked(id, false).then(onDone)}>
          Unblock
        </Button>
      }
    />
  );
}

/* ------------------------------ devices ------------------------------ */

function DevicesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => ctx.api.devices.list() });
  const pending = useQuery({ queryKey: ["links"], queryFn: () => ctx.api.devices.pendingLinks(), refetchInterval: 5000 });
  const [scan, setScan] = useState(false);
  useBus("link:request", () => void qc.invalidateQueries({ queryKey: ["links"] }));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["devices"] });
    void qc.invalidateQueries({ queryKey: ["links"] });
  };
  const icon = (p: string) => (p === "ios" || p === "android" ? <Smartphone className="h-5 w-5" /> : p === "desktop" ? <Monitor className="h-5 w-5" /> : <Laptop className="h-5 w-5" />);
  const current = devices.data?.devices.find((d) => d.current);
  const others = devices.data?.devices.filter((d) => !d.current) ?? [];

  return (
    <Page title="Devices">
      <Section footer="New devices get your encrypted history only after you approve them here.">
        <Row icon={<QrCode className="h-5 w-5" />} title="Link a device" subtitle="Scan the QR code shown on the new device" onClick={() => setScan(true)} trailing={chevron} />
      </Section>
      {!!pending.data?.requests.length && (
        <Section title="Waiting for approval" footer="Only approve if the code matches the one shown on your new device.">
          {pending.data.requests.map((r) => (
            <div key={r.linkId} className="flex items-center gap-3 px-4 py-3">
              {icon(r.platform)}
              <div className="flex-1">
                <div className="text-[15px] font-medium">{r.deviceName}</div>
                <div className="font-mono text-lg tracking-[0.3em] text-accent">{r.code}</div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => ctx.api.devices.rejectLink(r.linkId).then(refresh)}>
                Deny
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  await approveLink(r.linkId, fromB64(r.publicKey));
                  void haptic("success");
                  toast("Device linked");
                  refresh();
                }}
              >
                Approve
              </Button>
            </div>
          ))}
        </Section>
      )}
      {current && (
        <Section title="This device">
          <Row icon={icon(current.platform)} title={current.name} subtitle={`${current.platform} · online`} />
        </Section>
      )}
      <Section title="Active sessions">
        {devices.isLoading && <div className="flex justify-center p-4"><Spinner /></div>}
        {others.length === 0 && !devices.isLoading && <Row title="No other devices" />}
        {others.map((d) => (
          <Row
            key={d.id}
            icon={icon(d.platform)}
            title={d.name}
            subtitle={`${d.status === "pending" ? "pending approval · " : ""}${d.lastSeenAt ? `last active ${formatChatTime(d.lastSeenAt)}` : ""}${d.ip ? ` · ${d.ip}` : ""}`}
            trailing={
              <IconButton
                label="Terminate session"
                onClick={async () => {
                  const r = await confirm({ title: `Terminate ${d.name}?`, body: "That device will be logged out and its keys wiped.", confirm: "Terminate", danger: true });
                  if (r.ok) {
                    await ctx.api.devices.terminate(d.id);
                    refresh();
                  }
                }}
              >
                <Trash2 className="h-5 w-5 text-danger" />
              </IconButton>
            }
          />
        ))}
        {others.length > 1 && (
          <Row
            icon={<LogOut className="h-5 w-5" />}
            title="Terminate all other sessions"
            danger
            onClick={async () => {
              const r = await confirm({ title: "Terminate all other sessions?", confirm: "Terminate all", danger: true });
              if (!r.ok) return;
              for (const d of others) await ctx.api.devices.terminate(d.id).catch(() => {});
              refresh();
            }}
          />
        )}
      </Section>
      <Dialog open={scan} onOpenChange={setScan} title="Scan QR code" description="Point your camera at the code on the device you want to link.">
        {scan && (
          <QrScanner
            onResult={async (text) => {
              setScan(false);
              try {
                await approveLinkFromUri(text);
                void haptic("success");
                toast("Device linked");
                refresh();
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          />
        )}
      </Dialog>
    </Page>
  );
}

/* ------------------------------ notifications ------------------------------ */

function NotificationsPage() {
  const q = useQuery({ queryKey: ["notif"], queryFn: () => ctx.api.me.notifications() });
  const qc = useQueryClient();
  const g = (q.data?.global ?? {}) as { dnd?: boolean; quietHours?: { start: string; end: string; tz: string } | null; sound?: string; vibrate?: boolean };
  const scope = (s: string) => q.data?.scopes.find((x) => x.scope === s)?.mode ?? (s === "channels" ? "none" : "all");
  const save = async (b: Record<string, unknown>) => {
    await ctx.api.me.setNotifications(b);
    void qc.invalidateQueries({ queryKey: ["notif"] });
  };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (q.isLoading) return <Page title="Notifications"><Spinner /></Page>;
  return (
    <Page title="Notifications and Sounds">
      <Section footer="Push notifications never contain message content: it's end-to-end encrypted and the server can't read it.">
        <Row icon={<Moon className="h-5 w-5" />} title="Do Not Disturb" trailing={<Switch checked={!!g.dnd} onCheckedChange={(v) => void save({ global: { dnd: v } })} />} />
        <Row
          icon={<Bell className="h-5 w-5" />}
          title="Quiet hours"
          subtitle={g.quietHours ? `${g.quietHours.start} – ${g.quietHours.end}` : "Off"}
          trailing={<Switch checked={!!g.quietHours} onCheckedChange={(v) => void save({ global: { quietHours: v ? { start: "22:00", end: "07:00", tz } : null } })} />}
        />
        {g.quietHours && (
          <div className="flex gap-3 border-t border-border px-4 py-3">
            <label className="flex-1 text-sm text-muted">
              From
              <input type="time" value={g.quietHours.start} onChange={(e) => void save({ global: { quietHours: { ...g.quietHours!, start: e.target.value } } })} className="mt-1 h-10 w-full rounded-xl bg-surface px-3 text-text" />
            </label>
            <label className="flex-1 text-sm text-muted">
              To
              <input type="time" value={g.quietHours.end} onChange={(e) => void save({ global: { quietHours: { ...g.quietHours!, end: e.target.value } } })} className="mt-1 h-10 w-full rounded-xl bg-surface px-3 text-text" />
            </label>
          </div>
        )}
        <Row icon={<Smartphone className="h-5 w-5" />} title="Vibrate" trailing={<Switch checked={g.vibrate !== false} onCheckedChange={(v) => void save({ global: { vibrate: v } })} />} />
      </Section>
      <Section title="Defaults">
        {(
          [
            ["direct", "Private chats"],
            ["groups", "Groups"],
            ["channels", "Channels"],
          ] as const
        ).map(([s, label]) => (
          <div key={s} className="space-y-2 px-4 py-3 [&+&]:border-t [&+&]:border-border">
            <div className="text-[15px]">{label}</div>
            <Segmented value={scope(s)} onChange={(v) => void save({ scope: { scope: s, mode: v } })} options={[{ value: "all", label: "All" }, { value: "mentions", label: "Mentions" }, { value: "none", label: "Off" }]} />
          </div>
        ))}
      </Section>
      <Section title="Sound">
        <div className="px-4 py-3">
          <Segmented value={g.sound ?? "default"} onChange={(v) => void save({ global: { sound: v } })} options={[{ value: "default", label: "Default" }, { value: "chime", label: "Chime" }, { value: "pop", label: "Pop" }, { value: "none", label: "None" }]} />
        </div>
      </Section>
    </Page>
  );
}

/* ------------------------------ appearance / data / stickers ------------------------------ */

function AppearancePage() {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  if (!settings) return null;
  return (
    <Page title="Appearance">
      <Section title="Theme">
        <div className="grid grid-cols-3 gap-2 p-3">
          {(
            [
              ["system", "System", Monitor],
              ["light", "Light", Sun],
              ["dark", "Dark", Moon],
            ] as const
          ).map(([v, l, I]) => (
            <button key={v} onClick={() => (void haptic("selection"), setTheme(v))} className={cn("flex flex-col items-center gap-2 rounded-2xl p-3", theme === v ? "bg-accent-soft ring-2 ring-accent" : "bg-surface")}>
              <I className="h-6 w-6" />
              <span className="text-sm">{l}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Chats">
        <Row title="Send with Enter" subtitle="Desktop keyboards" trailing={<Switch checked={settings.sendWithEnter} onCheckedChange={(v) => void updateSettings({ sendWithEnter: v })} />} />
        <Row title="Link previews" trailing={<Switch checked={settings.linkPreviews} onCheckedChange={(v) => void updateSettings({ linkPreviews: v })} />} />
      </Section>
      <Section title="Quick reactions">
        <div className="flex flex-wrap gap-1 p-3">
          {["👍", "❤️", "🔥", "😂", "😮", "😢", "🙏", "👏", "🎉", "🤔", "👎", "💯"].map((e) => {
            const on = settings.reactionsQuick.includes(e);
            return (
              <button
                key={e}
                onClick={() => void updateSettings({ reactionsQuick: on ? settings.reactionsQuick.filter((x) => x !== e) : [...settings.reactionsQuick, e].slice(0, 8) })}
                className={cn("h-11 w-11 rounded-xl text-2xl", on ? "bg-accent-soft ring-2 ring-accent" : "bg-surface opacity-60")}
              >
                {e}
              </button>
            );
          })}
        </div>
      </Section>
    </Page>
  );
}

function DataPage() {
  const settings = useSettings();
  const [clearing, setClearing] = useState(false);
  if (!settings) return null;
  const set = (k: keyof typeof settings.autoDownload, v: AutoMode) => void updateSettings({ autoDownload: { ...settings.autoDownload, [k]: v } });
  return (
    <Page title="Data and Storage">
      <Section title="Automatic media download">
        {(["photo", "video", "document", "audio"] as const).map((k) => (
          <div key={k} className="space-y-2 px-4 py-3 [&+&]:border-t [&+&]:border-border">
            <div className="text-[15px] capitalize">{k === "document" ? "Files" : k === "audio" ? "Voice & audio" : `${k}s`}</div>
            <Segmented value={settings.autoDownload[k]} onChange={(v) => set(k, v)} options={[{ value: "always", label: "Always" }, { value: "wifi", label: "Wi-Fi" }, { value: "never", label: "Never" }]} />
          </div>
        ))}
      </Section>
      <Section footer="Removes decrypted media cached on this device. Files can be downloaded again while they exist.">
        <Row
          icon={<Trash2 className="h-5 w-5" />}
          title="Clear media cache"
          onClick={async () => {
            setClearing(true);
            const { openDB } = await import("idb");
            const db = await openDB("veil");
            await db.clear("media");
            setClearing(false);
            toast("Cache cleared");
          }}
          trailing={clearing ? <Spinner /> : undefined}
        />
      </Section>
    </Page>
  );
}

function StickersPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["stickers", "catalog"], queryFn: () => ctx.api.stickers.list(true) });
  return (
    <Page title="Stickers">
      <Section title="Sticker sets">
        {q.isLoading && <Spinner />}
        {q.data?.catalog.map((p) => {
          const pack = q.data.packs.find((x) => x.id === p.id);
          return (
            <Row
              key={p.id}
              icon={pack?.stickers[0] ? <img src={`${ctx.api.baseUrl}${pack.stickers[0].url}`} alt="" className="h-8 w-8" /> : <Sticker className="h-5 w-5" />}
              title={p.title}
              subtitle={pack ? `${pack.stickers.length} stickers` : undefined}
              trailing={
                <Button
                  size="sm"
                  variant={p.installed ? "secondary" : "primary"}
                  onClick={async () => {
                    if (p.installed) await ctx.api.stickers.uninstall(p.id);
                    else await ctx.api.stickers.install(p.id);
                    void qc.invalidateQueries({ queryKey: ["stickers"] });
                  }}
                >
                  {p.installed ? "Remove" : "Add"}
                </Button>
              }
            />
          );
        })}
      </Section>
    </Page>
  );
}
