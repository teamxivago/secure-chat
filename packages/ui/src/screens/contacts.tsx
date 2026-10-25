"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookUser, RefreshCw, Search, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { directChatId, presenceLabel } from "@veil/shared";
import { ctx, displayName, ensureChat, readDeviceContacts, syncPhoneContacts } from "../engine";
import { useUI } from "../store/ui";
import { Avatar } from "../components/avatar";
import { EmptyState, IconButton, Input, Spinner } from "../components/primitives";

export function ContactsScreen() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["contacts"], queryFn: () => ctx.api.contacts.list() });
  const { openChat, set } = useUI();
  const [q, setQ] = useState("");
  const [syncing, setSyncing] = useState(false);
  const sections = useMemo(() => {
    const list = (data?.contacts ?? []).filter((u) => !q || displayName(u).toLowerCase().includes(q.toLowerCase()) || u.username?.includes(q.toLowerCase()));
    list.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    const online = list.filter((u) => u.presence?.online);
    const by = new Map<string, typeof list>();
    for (const u of list) {
      const L = displayName(u)[0]?.toUpperCase() ?? "#";
      const k = /[A-Z]/.test(L) ? L : "#";
      by.set(k, [...(by.get(k) ?? []), u]);
    }
    return { online, letters: [...by.entries()] };
  }, [data, q]);

  async function sync() {
    setSyncing(true);
    try {
      const contacts = await readDeviceContacts();
      const cc = ctx.me?.phoneNumber?.match(/^\+(\d{1,3})/)?.[1] ?? "1";
      const matched = await syncPhoneContacts(contacts, cc);
      toast(`Found ${matched.length} contact${matched.length === 1 ? "" : "s"} on Veil`);
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const row = (u: NonNullable<typeof data>["contacts"][number]) => (
    <button
      key={u.id}
      onClick={async () => {
        await ensureChat(directChatId(u.id));
        openChat(directChatId(u.id));
      }}
      className="flex w-full items-center gap-3 px-4 py-2 hover:bg-surface"
    >
      <Avatar id={u.id} name={displayName(u)} mediaId={u.avatarMediaId} mediaKey={u.avatarKey} size={46} online={u.presence?.online} />
      <span className="min-w-0 text-left">
        <span className="block truncate text-[15px] font-medium">{displayName(u)}</span>
        <span className={u.presence?.online ? "block text-[13px] text-accent" : "block text-[13px] text-muted"}>{u.presence ? presenceLabel(u.presence) : ""}</span>
      </span>
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top shrink-0 px-4 pb-2">
        <div className="flex h-14 items-center">
          <h1 className="text-[26px] font-bold tracking-tight">Contacts</h1>
          <div className="ml-auto flex gap-1">
            <IconButton label="Sync phone contacts" onClick={sync} disabled={syncing}>
              {syncing ? <Spinner className="h-5 w-5" /> : <RefreshCw className="h-5 w-5" />}
            </IconButton>
            <IconButton label="Add contact" onClick={() => set({ newChat: "menu" })}>
              <UserPlus className="h-5 w-5" />
            </IconButton>
          </div>
        </div>
        <Input leading={<Search className="h-4 w-4" />} placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : !data?.contacts.length ? (
          <EmptyState
            icon={<BookUser className="h-8 w-8" />}
            title="No contacts yet"
            body="Find friends privately: phone numbers are matched with blinded tokens, so Veil never sees your address book."
            action={<button onClick={sync} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white">Find contacts</button>}
          />
        ) : (
          <>
            {sections.online.length > 0 && !q && (
              <>
                <div className="px-4 pb-1 pt-3 text-[13px] font-medium uppercase text-muted">Online now</div>
                {sections.online.map(row)}
              </>
            )}
            {sections.letters.map(([letter, list]) => (
              <div key={letter}>
                <div className="sticky top-0 z-[1] bg-bg/90 px-4 py-1 text-[13px] font-semibold text-accent backdrop-blur">{letter}</div>
                {list.map(row)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
