import { isDirectChatId, peerFromChatId, type EnvelopeWire, type GroupMessageWire } from "@veil/shared";
import { allChats, getChat, kvGet, kvSet, putChat } from "../lib/db";
import { completeSignIn, loadConfig, maintainKeys, refreshMe, signOut } from "./account";
import { bus } from "./bus";
import { refreshServerChat, refreshServerChats, updateChat } from "./chats";
import { ctx } from "./context";
import { invalidateDevices } from "./direct";
import { invalidateMemberDevices } from "./groups";
import { flushOutbox } from "./messages";
import { handleEnvelope, handleGroupEphemeral, handleGroupMessage, setAppVisible } from "./receive";
import { connect, disconnect, emit, enqueue, on, request, setOnConnect } from "./transport";
import { getUser, updatePresence } from "./users";
import { flush as flushVault, pull as pullVault } from "./vault";
import { trace } from "../lib/trace";

export { bus, ctx };
export * from "./account";
export * from "./messages";
export * from "./chats";
export * from "./users";
export * from "./media";
export * from "./search";
export * from "./settings";
export * from "./contacts";
export * from "./export";
export { contentPreview } from "./preview";
export { setActiveChat, setAppVisible } from "./receive";
export { connectionState } from "./transport";

let started = false;

/** Boots the engine: restores the account, connects, and runs the initial sync. */
export async function startEngine(): Promise<"signed-out" | "pending" | "active"> {
  await ctx.loadPersisted();
  await loadConfig();
  if (!ctx.account?.token) return "signed-out";
  try {
    await refreshMe();
  } catch (e) {
    if ((e as { status?: number }).status === 401) {
      await signOut({ remote: false });
      return "signed-out";
    }
    // Offline: continue with cached data.
  }
  if (!ctx.account.deviceId) {
    const { ensureDevice } = await import("./account");
    await ensureDevice();
  }
  wire();
  connect();
  return ctx.active ? "active" : "pending";
}

export async function signInWithToken(token: string) {
  await loadConfig();
  await completeSignIn(token);
  wire();
  connect();
}

/** Re-checks device status (pending → active after linking) and rejoins rooms. */
export async function refreshDeviceStatus() {
  const r = await request<{ status: "pending" | "active" | null }>("device:refresh", {}).catch(() => null);
  if (r?.status && ctx.account) {
    ctx.account.status = r.status;
    await ctx.saveAccount();
  }
  if (ctx.active) await initialSync();
  bus.emit("account:changed", undefined);
}

async function pullEnvelopes() {
  let after = 0;
  for (;;) {
    const r = await request<{ envelopes: EnvelopeWire[]; more: boolean }>("pull", { after }, 30000);
    const ids: string[] = [];
    for (const env of r.envelopes) {
      await handleEnvelope(env).catch((e) => console.error("[pull] envelope", e));
      ids.push(env.id);
    }
    if (ids.length) emit("ack", ids);
    if (!r.more || !r.envelopes.length) break;
    after = Number(r.envelopes[r.envelopes.length - 1].id);
  }
}

async function syncGroups() {
  for (let round = 0; round < 50; round++) {
    const chats = (await allChats()).filter((c) => c.type === "group" || c.type === "channel");
    const cursors = Object.fromEntries(chats.map((c) => [c.id, c.groupCursor ?? c.summary?.joinedSeq ?? 0]));
    const r = await request<{ messages: GroupMessageWire[] }>("group:sync", cursors, 30000);
    for (const gm of r.messages) await handleGroupMessage(gm, false).catch((e) => console.error("[sync] group", e));
    if (r.messages.length < 500) break;
  }
}

async function subscribePresence() {
  const chats = await allChats();
  const peers = chats.filter((c) => isDirectChatId(c.id)).map((c) => peerFromChatId(c.id)!).filter((p) => p !== ctx.account?.userId);
  emit("presence:sub", [...new Set(peers)].slice(0, 500));
}

let syncing: Promise<void> | null = null;
async function initialSync() {
  trace("sync:requested", { active: ctx.active, running: !!syncing });
  syncing ??= (async () => {
    if (!ctx.active) return;
    trace("sync:start");
    await flushVault().catch(() => {});
    if (!(await kvGet<boolean>("vault:imported"))) {
      await pullVault().catch((e) => console.warn("[sync] vault", e));
      await kvSet("vault:imported", true);
    } else await pullVault().catch(() => {});
    trace("sync:vault-done");
    await refreshServerChats().catch((e) => console.warn("[sync] chats", e));
    await pullEnvelopes().catch((e) => console.warn("[sync] envelopes", e));
    await syncGroups().catch((e) => console.warn("[sync] groups", e));
    await subscribePresence();
    await maintainKeys().catch((e) => console.warn("[keys]", e));
    await flushOutbox();
  })().finally(() => (syncing = null));
  return syncing;
}

function wire() {
  if (started) return;
  started = true;
  setOnConnect(async () => {
    const r = await request<{ status: "pending" | "active" | null }>("device:refresh", {}).catch(() => null);
    if (r?.status && ctx.account && ctx.account.status !== r.status) {
      ctx.account.status = r.status;
      await ctx.saveAccount();
      bus.emit("account:changed", undefined);
    }
    await initialSync();
  });

  on("envelope", async (d) => {
    const env = d as EnvelopeWire;
    await handleEnvelope(env);
    if (!env.ephemeral) emit("ack", [env.id]);
  });
  on("group:message", (d) => handleGroupMessage(d as GroupMessageWire));
  on("group:ephemeral", (d) => handleGroupEphemeral(d as { chatId: string; ciphertext: string }));
  on(
    "presence",
    (d) => {
      const p = d as { userId: string; online: boolean; lastSeenAt: number | null; approx?: string };
      updatePresence(p.userId, p.online, p.lastSeenAt, p.approx);
      bus.emit("presence", p);
    },
    false,
  );
  on("chat:members", async (d) => {
    const { chatId, removed, added } = d as { chatId: string; removed?: string[]; added?: string[] };
    invalidateMemberDevices(chatId);
    if (removed?.includes(ctx.account?.userId ?? "")) await refreshServerChats();
    else await refreshServerChat(chatId);
    void added;
  });
  on("chat:epoch", async (d) => {
    const { chatId, epoch } = d as { chatId: string; epoch: number };
    const c = await getChat(chatId);
    if (c?.summary) {
      c.summary.keyEpoch = Math.max(c.summary.keyEpoch, epoch);
      await putChat(c);
    }
    invalidateMemberDevices(chatId);
  });
  for (const ev of ["chat:updated", "chat:added", "chat:joinRequest"]) on(ev, async (d) => void (await refreshServerChat((d as { chatId: string }).chatId)));
  on("chat:pins", async (d) => {
    const { chatId, pinnedIds } = d as { chatId: string; pinnedIds: string[] };
    await updateChat(chatId, (c) => void (c.pinnedMessageIds = pinnedIds), { sync: false });
  });
  on("chat:removed", async () => void (await refreshServerChats()));
  on("chat:deleted", async (d) => {
    const { chatId } = d as { chatId: string };
    await updateChat(chatId, (c) => void (c.summary = c.summary ? { ...c.summary, myRole: null } : c.summary), { sync: false });
  });
  on("device:revoked", async () => {
    disconnect();
    await signOut({ remote: false });
    bus.emit("device:revoked", undefined);
  });
  on("device:activated", async () => void (await refreshDeviceStatus()));
  on("devices:changed", async (d) => void (await invalidateDevices((d as { userId: string }).userId)));
  on("keys:low", async () => void (await maintainKeys()));
  on("link:request", (d) => bus.emit("link:request", d as { linkId: string; deviceName: string; platform: string }), false);
  on("link:approved", () => bus.emit("account:changed", undefined), false);
  on("vault:changed", async () => void (await pullVault()));
  on("me:updated", async () => void (await refreshMe()), false);
  on("profile:updated", async (d) => void (await getUser((d as { userId: string }).userId, true)), false);
  on("blocks:updated", async () => {}, false);

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      const visible = document.visibilityState === "visible";
      setAppVisible(visible);
      emit(visible ? "presence:back" : "presence:away");
    });
    setInterval(() => emit("presence:ping"), 30_000);
  }
}

export async function stopEngine() {
  disconnect();
}

export { enqueue as runSerialized };
export * from "./calls";
export * from "./uploads";
export { vaultWrite } from "./vault";
