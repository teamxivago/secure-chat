"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { ThemeProvider, useTheme } from "next-themes";
import { BookUser, MessageCircle, Phone, Settings as SettingsIcon, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  bus,
  ctx,
  ensureChat,
  getLockSettings,
  initCalls,
  refreshServerChats,
  signInWithToken,
  startEngine,
} from "./engine";
import { useChats, useMediaQuery } from "./hooks";
import { cn } from "./lib/cn";
import { enableSecureScreen, haptic, hideSplash, onAppStateChange, onBackButton, onDeepLink, registerPush, setBadge, setStatusBar, showLocalNotification } from "./lib/native";
import { isNative } from "./lib/platform";
import { useUI, type Tab } from "./store/ui";
import { ConfirmProvider, Dialog } from "./components/overlays";
import { Badge, Button, EmptyState, Spinner } from "./components/primitives";
import { VeilLogo } from "./components/brand";
import { Avatar } from "./components/avatar";
import { ForwardDialog, ReportDialog } from "./components/dialogs";
import { MediaViewer } from "./components/viewer";
import { LoginScreen, OnboardingScreen } from "./screens/auth";
import { LinkDeviceScreen } from "./screens/link";
import { ChatListScreen } from "./screens/chat-list";
import { ChatView } from "./screens/chat-view";
import { ChatInfoPanel, UserPanel } from "./screens/info";
import { GlobalSearch } from "./screens/search";
import { NewChatSheet } from "./screens/new-chat";
import { ContactsScreen } from "./screens/contacts";
import { CallOverlay, CallsScreen } from "./screens/calls";
import { SettingsScreen } from "./screens/settings";
import { AppLockScreen } from "./screens/lock";

type Phase = "booting" | "signed-out" | "pending" | "onboarding" | "ready";

function phaseNow(): Phase {
  if (!ctx.account?.token) return "signed-out";
  if (!ctx.active) return "pending";
  if (ctx.me && !ctx.me.onboarded) return "onboarding";
  return "ready";
}

/* ------------------------------ navigation ------------------------------ */

const TABS: { id: Tab; label: string; icon: typeof MessageCircle }[] = [
  { id: "chats", label: "Chats", icon: MessageCircle },
  { id: "contacts", label: "Contacts", icon: BookUser },
  { id: "calls", label: "Calls", icon: Phone },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function BottomNav() {
  const { tab, setTab } = useUI();
  const { chats } = useChats();
  const unread = chats.filter((c) => c.unread > 0 && !c.archived && !((c.mutedUntil ?? 0) > Date.now())).length;
  useEffect(() => void setBadge(chats.reduce((n, c) => n + (c.archived ? 0 : c.unread), 0)), [chats]);
  return (
    <nav className="safe-bottom shrink-0 border-t border-border bg-bg/90 backdrop-blur-xl">
      <div className="flex h-14">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => {
              if (tab !== t.id) void haptic("light");
              setTab(t.id);
            }}
            className={cn("relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors", tab === t.id ? "text-accent" : "text-muted")}
          >
            <t.icon className="h-6 w-6" strokeWidth={tab === t.id ? 2.4 : 1.8} />
            {t.label}
            {t.id === "chats" && unread > 0 && <Badge className="absolute left-1/2 top-1 ml-1.5">{unread}</Badge>}
          </button>
        ))}
      </div>
    </nav>
  );
}

function TabContent() {
  const tab = useUI((s) => s.tab);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} className="absolute inset-0" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          {tab === "chats" ? <ChatListScreen /> : tab === "contacts" ? <ContactsScreen /> : tab === "calls" ? <CallsScreen /> : <SettingsScreen />}
        </motion.div>
      </AnimatePresence>
      <GlobalSearch />
    </div>
  );
}

function SidePanel() {
  const { panel, setPanel } = useUI();
  if (!panel) return null;
  return panel.kind === "user" ? <UserPanel userId={panel.userId} onClose={() => setPanel(null)} /> : <ChatInfoPanel chatId={panel.chatId} onClose={() => setPanel(null)} />;
}

function Shell() {
  const isTablet = useMediaQuery("(min-width: 768px)");
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const { activeChatId, panel, setPanel } = useUI();
  const spring = { type: "spring", stiffness: 420, damping: 40 } as const;

  if (!isTablet) {
    // Mobile: full-screen chat over tabs with a push transition.
    return (
      <div className="relative flex h-full flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <TabContent />
          <BottomNav />
        </div>
        <AnimatePresence>
          {activeChatId && (
            <motion.div key={activeChatId} className="absolute inset-0 z-20 bg-bg shadow-float" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={spring}>
              <ChatView chatId={activeChatId} />
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {panel && (
            <motion.div className="absolute inset-0 z-30 bg-bg" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={spring}>
              <SidePanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="relative flex w-[340px] shrink-0 flex-col border-r border-border lg:w-[380px]">
        <TabContent />
        <BottomNav />
      </aside>
      <main className="relative min-w-0 flex-1">
        {activeChatId ? (
          <ChatView key={activeChatId} chatId={activeChatId} />
        ) : (
          <div className="chat-wallpaper flex h-full items-center justify-center">
            <EmptyState icon={<ShieldCheck className="h-8 w-8" />} title="Select a chat" body="Your messages are end-to-end encrypted with the Signal Protocol. Only you and the people you talk to can read them." />
          </div>
        )}
        {!isDesktop && (
          <AnimatePresence>
            {panel && (
              <>
                <motion.div className="absolute inset-0 z-20 bg-black/30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setPanel(null)} />
                <motion.div className="absolute inset-y-0 right-0 z-30 w-[380px] max-w-full border-l border-border bg-bg shadow-float" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={spring}>
                  <SidePanel />
                </motion.div>
              </>
            )}
          </AnimatePresence>
        )}
      </main>
      {isDesktop && (
        <AnimatePresence initial={false}>
          {panel && (
            <motion.aside className="shrink-0 overflow-hidden border-l border-border" initial={{ width: 0 }} animate={{ width: 380 }} exit={{ width: 0 }} transition={spring}>
              <div className="h-full w-[380px]">
                <SidePanel />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}

/* ------------------------------ invite links ------------------------------ */

function JoinDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof ctx.api.invites.preview>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openChat = useUI((s) => s.openChat);
  useEffect(() => {
    setPreview(null);
    setError(null);
    if (token) ctx.api.invites.preview(token).then(setPreview).catch((e) => setError(e.message));
  }, [token]);
  return (
    <Dialog open={!!token} onOpenChange={(o) => !o && onClose()} title="Join">
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !preview ? (
        <div className="flex justify-center p-6"><Spinner /></div>
      ) : (
        <div className="flex flex-col items-center text-center">
          <Avatar id={preview.chatId} name={preview.title} mediaId={preview.avatarMediaId} mediaKey={preview.avatarKey} size={88} kind={preview.type === "channel" ? "channel" : "group"} />
          <h3 className="mt-3 text-lg font-semibold">{preview.title}</h3>
          <p className="text-sm text-muted">{preview.memberCount >= 0 ? `${preview.memberCount} ${preview.type === "channel" ? "subscribers" : "members"}` : preview.type}</p>
          {preview.description && <p className="mt-2 text-[15px]">{preview.description}</p>}
          <Button
            className="mt-5 w-full"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await ctx.api.invites.join(token!);
                if ("requested" in r) toast("Request sent — an admin will review it");
                else {
                  await ensureChat(r.id, r);
                  await refreshServerChats();
                  openChat(r.id);
                }
                onClose();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {preview.isMember ? "Open" : preview.requiresApproval ? "Request to join" : preview.type === "channel" ? "Subscribe" : "Join group"}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------ root ------------------------------ */

function Root() {
  const [phase, setPhase] = useState<Phase>("booting");
  const [locked, setLocked] = useState(() => typeof window !== "undefined" && getLockSettings().enabled);
  const [shield, setShield] = useState(false);
  const [joinToken, setJoinToken] = useState<string | null>(null);
  const hiddenAt = useRef<number | null>(null);
  const { resolvedTheme } = useTheme();
  const { openChat, activeChatId, panel, setPanel } = useUI();

  const recompute = useCallback(() => setPhase(phaseNow()), []);

  useEffect(() => {
    void (async () => {
      try {
        let status = await startEngine();
        if (status === "signed-out" && !isNative()) {
          // Returning from OAuth (cookie session): exchange for a bearer token.
          const s = await ctx.api.auth.session().catch(() => null);
          if (s?.session?.token) {
            await signInWithToken(s.session.token);
            status = ctx.active ? "active" : "pending";
            window.history.replaceState(null, "", window.location.pathname.replace(/\/$/, "") || "/");
          }
        }
      } catch (e) {
        console.error("[boot]", e);
        toast.error("Couldn't reach Veil. Retrying when the network is back.");
      }
      recompute();
      void hideSplash();
    })();
    return bus.on("account:changed", recompute);
  }, [recompute]);

  useEffect(() => bus.on("device:revoked", () => toast("This device was logged out from another session.")), []);
  useEffect(() => void setStatusBar(resolvedTheme === "dark"), [resolvedTheme]);

  // Lock on resume after the configured timeout; hide content in the app switcher.
  useEffect(() => {
    let off: (() => void) | undefined;
    void onAppStateChange((active) => {
      const lock = getLockSettings();
      if (!active) {
        hiddenAt.current = Date.now();
        setShield(true);
        if (lock.enabled && lock.timeoutSec === 0) setLocked(true);
      } else {
        setShield(false);
        if (lock.enabled && hiddenAt.current && Date.now() - hiddenAt.current >= lock.timeoutSec * 1000) setLocked(true);
        hiddenAt.current = null;
      }
    }).then((f) => (off = f));
    return () => off?.();
  }, []);

  // App-wide screenshot / recording protection on mobile.
  useEffect(() => {
    void enableSecureScreen();
  }, []);

  // Ready-state services.
  useEffect(() => {
    if (phase !== "ready") return;
    initCalls();
    void registerPush(
      (token, platform) => void ctx.api.devices.update({ pushToken: token, pushPlatform: platform }).catch(() => {}),
      (data) => data.chatId && openChat(data.chatId),
    ).catch(() => {});
    const offNotify = bus.on("notify", (n) => {
      if (document.visibilityState === "visible") {
        toast(n.title, { description: n.body, action: { label: "Open", onClick: () => openChat(n.chatId) } });
      } else void showLocalNotification(n.title, n.body, { chatId: n.chatId });
    });
    const offScreenshot = bus.on("screenshot", () => void haptic("warning"));
    const onOpen = (e: Event) => openChat((e as CustomEvent<string>).detail);
    window.addEventListener("veil:open-chat", onOpen);
    // Web invite links: /join/<token>
    const m = window.location.pathname.match(/^\/join\/([\w-]+)/);
    if (m) {
      setJoinToken(m[1]);
      window.history.replaceState(null, "", "/");
    }
    return () => {
      offNotify();
      offScreenshot();
      window.removeEventListener("veil:open-chat", onOpen);
    };
  }, [phase, openChat]);

  // Native deep links: veil://join/<token>, veil://auth?token=…
  useEffect(() => {
    let off: (() => void) | undefined;
    void onDeepLink(async (url) => {
      const u = new URL(url.replace(/^veil:\/\//, "https://veil.invalid/"));
      if (u.pathname.startsWith("/auth") && u.searchParams.get("token")) {
        await signInWithToken(u.searchParams.get("token")!);
        recompute();
      } else if (u.pathname.startsWith("/join/")) setJoinToken(u.pathname.split("/")[2]);
    }).then((f) => (off = f));
    return () => off?.();
  }, [recompute]);

  useEffect(() => {
    let off: (() => void) | undefined;
    void onBackButton(() => {
      if (panel) return setPanel(null), true;
      if (activeChatId) return openChat(null), true;
      return false;
    }).then((f) => (off = f));
    return () => off?.();
  }, [panel, activeChatId, setPanel, openChat]);

  const content = useMemo(() => {
    switch (phase) {
      case "booting":
        return (
          <div className="flex h-full flex-col items-center justify-center gap-6">
            <motion.div animate={{ scale: [1, 1.05, 1] }} transition={{ repeat: Infinity, duration: 1.8 }}>
              <VeilLogo size={72} />
            </motion.div>
            <Spinner />
          </div>
        );
      case "signed-out":
        return <LoginScreen />;
      case "pending":
        return <LinkDeviceScreen />;
      case "onboarding":
        return <OnboardingScreen />;
      case "ready":
        return (
          <>
            <Shell />
            <NewChatSheet />
            <ForwardDialog />
            <ReportDialog />
            <MediaViewer />
            <CallOverlay />
            <JoinDialog token={joinToken} onClose={() => setJoinToken(null)} />
          </>
        );
    }
  }, [phase, joinToken]);

  const lockActive = locked && getLockSettings().enabled && phase !== "signed-out";

  return (
    <div className="h-[100dvh] w-full overflow-hidden bg-bg text-text">
      {lockActive ? <AppLockScreen onUnlock={() => setLocked(false)} /> : content}
      {shield && !lockActive && phase === "ready" && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-bg">
          <VeilLogo size={64} />
        </div>
      )}
    </div>
  );
}

export function VeilApp({ apiBase }: { apiBase?: string }) {
  if (apiBase !== undefined && typeof window !== "undefined") globalThis.__VEIL_API_BASE__ = apiBase;
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } } }));
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <Root />
        <ThemedToaster />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

/** Place in the (server-rendered) root layout so the theme script runs before first paint. */
export function VeilThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      {children}
    </ThemeProvider>
  );
}

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position="top-center"
      offset={16}
      toastOptions={{ classNames: { toast: "!rounded-2xl !shadow-float !border-border", actionButton: "!bg-accent !text-white" } }}
    />
  );
}
