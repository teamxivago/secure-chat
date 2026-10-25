"use client";
import { KeyRound, Laptop, RefreshCw, ShieldAlert, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ctx, pollLinking, recoverWithKey, refreshDeviceStatus, signOut, startFresh, startLinking, type LinkSession } from "../engine";
import { haptic } from "../lib/native";
import { VeilLogo } from "../components/brand";
import { Button, Input, Spinner } from "../components/primitives";
import { useConfirm, Dialog } from "../components/overlays";
import { useBus } from "../hooks";

/**
 * Shown on a device that signed in but hasn't been approved. History and keys only arrive after an
 * existing device approves it (QR scan or code comparison), or the user restores with a recovery key.
 */
export function LinkDeviceScreen() {
  const [session, setSession] = useState<LinkSession | null>(null);
  const [qr, setQr] = useState<string>("");
  const [recovery, setRecovery] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const reg = useRef<{ activeDevices: number; hasBackup: boolean } | null>(null);

  async function begin() {
    try {
      const s = await startLinking();
      setSession(s);
      setQr(await QRCode.toDataURL(s.uri, { margin: 1, width: 520, color: { dark: "#0F0F1A", light: "#FFFFFF" }, errorCorrectionLevel: "M" }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const started = useRef(false);
  useEffect(() => {
    // Guard against double-mount (StrictMode) creating two link requests.
    if (started.current) return;
    started.current = true;
    void begin();
    void import("../lib/db").then(({ kvGet }) => kvGet<{ activeDevices: number; hasBackup: boolean }>("device:registration").then((r) => (reg.current = r ?? null)));
  }, []);

  useEffect(() => {
    if (!session) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await pollLinking(session);
        if (r === "approved") {
          void haptic("success");
          await refreshDeviceStatus();
          return;
        }
        if (r === "rejected") {
          toast.error("The link request was declined");
          void haptic("error");
          await begin();
          return;
        }
      } catch (e) {
        if ((e as { status?: number }).status === 404) return void begin();
      }
      if (Date.now() > session.expiresAt) return void begin();
      setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [session]);

  useBus("account:changed", () => {
    if (ctx.active) void refreshDeviceStatus();
  });

  async function doRecover() {
    setBusy(true);
    try {
      await recoverWithKey(key);
      await refreshDeviceStatus();
      void haptic("success");
    } catch (e) {
      void haptic("error");
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function fresh() {
    const r = await confirm({
      title: "Start fresh on this device?",
      body: "Your other devices will be logged out and your existing encrypted history can't be restored here. Contacts will see that your security code changed.",
      confirm: "Start fresh",
      danger: true,
    });
    if (!r.ok) return;
    setBusy(true);
    try {
      await startFresh();
      await refreshDeviceStatus();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="safe-top safe-bottom flex min-h-full items-center justify-center bg-bg px-6 py-10">
      <div className="w-full max-w-md text-center">
        <VeilLogo size={52} />
        <h1 className="mt-4 text-[24px] font-semibold tracking-tight">Link this device</h1>
        <p className="mx-auto mt-2 max-w-sm text-[15px] text-muted">
          Open Veil on a device you're already signed in on, go to <b className="text-text">Settings → Devices → Link a device</b> and scan this code.
        </p>
        <div className="mx-auto mt-6 flex h-[260px] w-[260px] items-center justify-center rounded-3xl bg-white p-4 shadow-float ring-1 ring-border">
          {qr ? <img src={qr} alt="Link code" className="h-full w-full" /> : <Spinner />}
        </div>
        {session && (
          <div className="mt-4">
            <p className="text-sm text-muted">Or approve it there and check this code matches:</p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.35em]" data-testid="link-code">
              {session.code}
            </p>
          </div>
        )}
        <div className="mt-6 flex flex-col gap-2">
          <Button variant="ghost" onClick={() => setRecovery(true)}>
            <KeyRound className="h-4 w-4" /> Use recovery key instead
          </Button>
          <Button variant="ghost" onClick={() => void begin()}>
            <RefreshCw className="h-4 w-4" /> New code
          </Button>
          <Button variant="ghost" className="text-danger" onClick={fresh} loading={busy}>
            <ShieldAlert className="h-4 w-4" /> I don't have my other devices
          </Button>
          <button className="mt-2 text-sm text-muted hover:text-text" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
        <div className="mt-6 flex items-center justify-center gap-6 text-subtle">
          <Smartphone className="h-5 w-5" />
          <span className="h-px w-10 bg-border" />
          <Laptop className="h-5 w-5" />
        </div>
      </div>
      <Dialog open={recovery} onOpenChange={setRecovery} title="Restore with recovery key" description="Enter the 64-character recovery key you saved when you set it up.">
        <Input placeholder="XXXX-XXXX-…" value={key} onChange={(e) => setKey(e.target.value)} autoCapitalize="characters" className="font-mono" />
        <Button className="mt-4 w-full" loading={busy} onClick={doRecover} disabled={key.replace(/[^A-Za-z0-9]/g, "").length < 64}>
          Restore
        </Button>
      </Dialog>
    </div>
  );
}
