"use client";
import { motion } from "framer-motion";
import { Delete, Fingerprint, Lock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getLockSettings, saveLockSettings, signOut, verifyPin } from "../engine";
import { biometricAuthenticate, biometricAvailable, haptic } from "../lib/native";
import { cn } from "../lib/cn";
import { VeilLogo } from "../components/brand";
import { useConfirm } from "../components/overlays";

/** Custom numeric keypad — the system keyboard is never shown for the passcode. */
export function PinPad({
  length,
  variable,
  onComplete,
  extra,
}: {
  length?: number;
  variable?: boolean;
  onComplete: (pin: string) => Promise<boolean> | boolean;
  extra?: React.ReactNode;
}) {
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = length ?? 6;

  const submit = useCallback(
    async (value: string) => {
      setBusy(true);
      const ok = await onComplete(value);
      setBusy(false);
      if (!ok) {
        void haptic("error");
        setShake(true);
        setTimeout(() => setShake(false), 450);
      }
      setPin("");
    },
    [onComplete],
  );

  const press = (d: string) => {
    if (busy) return;
    void haptic("light");
    const next = (pin + d).slice(0, variable ? 6 : target);
    setPin(next);
    if (!variable && next.length === target) void submit(next);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      if (e.key === "Enter" && variable && pin.length >= 4) void submit(pin);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "extra", "0", "del"];
  const dots = variable ? Math.max(4, pin.length) : target;
  return (
    <div className="flex flex-col items-center">
      <div className={cn("mb-8 flex h-4 gap-4", shake && "animate-shake")} data-testid="pin-dots">
        {Array.from({ length: dots }).map((_, i) => (
          <motion.span key={i} animate={{ scale: i < pin.length ? 1.15 : 1 }} className={cn("h-3.5 w-3.5 rounded-full border-2", i < pin.length ? "border-accent bg-accent" : "border-subtle")} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-x-7 gap-y-4">
        {keys.map((k) =>
          k === "extra" ? (
            <div key={k} className="flex h-[72px] w-[72px] items-center justify-center">
              {variable && pin.length >= 4 ? (
                <button onClick={() => void submit(pin)} className="text-[15px] font-semibold text-accent">
                  OK
                </button>
              ) : (
                extra
              )}
            </div>
          ) : k === "del" ? (
            <button key={k} aria-label="Delete" onClick={() => (void haptic("light"), setPin((p) => p.slice(0, -1)))} className="flex h-[72px] w-[72px] items-center justify-center rounded-full text-muted active:bg-surface">
              <Delete className="h-7 w-7" />
            </button>
          ) : (
            <motion.button
              key={k}
              whileTap={{ scale: 0.9 }}
              onClick={() => press(k)}
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-surface text-[30px] font-light tabular-nums transition hover:bg-surface-2"
            >
              {k}
            </motion.button>
          ),
        )}
      </div>
    </div>
  );
}

const MAX_BIO_FAILS = 3;

/** Full-screen gate rendered above everything (nothing behind it is visible). */
export function AppLockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [settings, setSettings] = useState(getLockSettings());
  const [bioLabel, setBioLabel] = useState<string | null>(null);
  const [bioFails, setBioFails] = useState(0);
  const [now, setNow] = useState(Date.now());
  const confirm = useConfirm();
  const lockedOut = (settings.lockedUntil ?? 0) > now;

  const tryBio = useCallback(async () => {
    const ok = await biometricAuthenticate();
    if (ok) {
      void haptic("success");
      saveLockSettings({ ...getLockSettings(), failedAttempts: 0 });
      onUnlock();
    } else setBioFails((f) => f + 1);
  }, [onUnlock]);

  useEffect(() => {
    if (settings.method === "pin") return;
    void biometricAvailable().then((b) => {
      if (!b.available) return;
      setBioLabel(b.label);
      void tryBio();
    });
  }, [settings.method, tryBio]);

  useEffect(() => {
    if (!lockedOut) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [lockedOut]);

  async function check(pin: string) {
    if (lockedOut) return false;
    if (await verifyPin(pin)) {
      void haptic("success");
      saveLockSettings({ ...getLockSettings(), failedAttempts: 0, lockedUntil: 0 });
      onUnlock();
      return true;
    }
    const s = getLockSettings();
    const failed = (s.failedAttempts ?? 0) + 1;
    // Escalating delays after 5 wrong attempts: 30s, 1m, 2m, 4m…
    const lockedUntil = failed >= 5 ? Date.now() + 30_000 * 2 ** Math.min(6, failed - 5) : 0;
    const next = { ...s, failedAttempts: failed, lockedUntil };
    saveLockSettings(next);
    setSettings(next);
    setNow(Date.now());
    return false;
  }

  const showBio = bioLabel && bioFails < MAX_BIO_FAILS;

  return (
    <div className="safe-top safe-bottom fixed inset-0 z-[100] flex flex-col items-center justify-center bg-bg" data-testid="app-lock">
      <VeilLogo size={56} />
      <h1 className="mt-5 flex items-center gap-2 text-xl font-semibold">
        <Lock className="h-5 w-5" /> Enter passcode
      </h1>
      <p className="mb-8 mt-1 h-5 text-sm text-muted">
        {lockedOut
          ? `Too many attempts. Try again in ${Math.ceil(((settings.lockedUntil ?? 0) - now) / 1000)}s`
          : (settings.failedAttempts ?? 0) > 0
            ? `${settings.failedAttempts} failed attempt${settings.failedAttempts === 1 ? "" : "s"}`
            : bioFails >= MAX_BIO_FAILS
              ? "Use your passcode"
              : ""}
      </p>
      <PinPad
        length={settings.pinLength ?? 4}
        onComplete={check}
        extra={
          showBio ? (
            <button onClick={() => void tryBio()} aria-label={`Unlock with ${bioLabel}`} className="text-accent">
              <Fingerprint className="h-8 w-8" />
            </button>
          ) : null
        }
      />
      <button
        className="mt-10 text-sm text-muted hover:text-text"
        onClick={async () => {
          const r = await confirm({ title: "Forgot passcode?", body: "You'll be logged out and this device's local data wiped. You can sign in again and re-link the device.", confirm: "Log out", danger: true });
          if (r.ok) await signOut();
        }}
      >
        Forgot passcode?
      </button>
    </div>
  );
}
