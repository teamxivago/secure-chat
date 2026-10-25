"use client";
import { motion } from "framer-motion";
import { AtSign, Camera, Check, ChevronLeft, Lock, Mail, Phone, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BIO_MAX, USERNAME_RE } from "@veil/shared";
import { ctx, refreshMe, signInWithToken, uploadEncrypted } from "../engine";
import { haptic } from "../lib/native";
import { isNative } from "../lib/platform";
import { cn } from "../lib/cn";
import { VeilLogo } from "../components/brand";
import { Button, Input, Segmented, Spinner, Textarea } from "../components/primitives";

const COUNTRIES = [
  ["US", "+1", "🇺🇸"], ["GB", "+44", "🇬🇧"], ["IN", "+91", "🇮🇳"], ["DE", "+49", "🇩🇪"], ["FR", "+33", "🇫🇷"], ["ES", "+34", "🇪🇸"],
  ["IT", "+39", "🇮🇹"], ["BR", "+55", "🇧🇷"], ["MX", "+52", "🇲🇽"], ["CA", "+1", "🇨🇦"], ["AU", "+61", "🇦🇺"], ["JP", "+81", "🇯🇵"],
  ["KR", "+82", "🇰🇷"], ["CN", "+86", "🇨🇳"], ["SG", "+65", "🇸🇬"], ["AE", "+971", "🇦🇪"], ["SA", "+966", "🇸🇦"], ["TR", "+90", "🇹🇷"],
  ["RU", "+7", "🇷🇺"], ["UA", "+380", "🇺🇦"], ["NL", "+31", "🇳🇱"], ["SE", "+46", "🇸🇪"], ["NG", "+234", "🇳🇬"], ["ZA", "+27", "🇿🇦"],
  ["ID", "+62", "🇮🇩"], ["PK", "+92", "🇵🇰"], ["BD", "+880", "🇧🇩"], ["PH", "+63", "🇵🇭"], ["VN", "+84", "🇻🇳"], ["EG", "+20", "🇪🇬"],
] as const;

export function OtpInput({ length = 6, onComplete, disabled, error }: { length?: number; onComplete: (code: string) => void; disabled?: boolean; error?: boolean }) {
  const [digits, setDigits] = useState<string[]>(Array(length).fill(""));
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => refs.current[0]?.focus(), []);
  useEffect(() => {
    if (error) {
      setDigits(Array(length).fill(""));
      refs.current[0]?.focus();
    }
  }, [error, length]);
  const update = (i: number, v: string) => {
    const clean = v.replace(/\D/g, "");
    if (clean.length > 1) {
      const next = clean.slice(0, length).split("");
      const filled = [...next, ...Array(length - next.length).fill("")];
      setDigits(filled);
      if (next.length === length) onComplete(next.join(""));
      else refs.current[next.length]?.focus();
      return;
    }
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    void haptic("selection");
    if (clean && i < length - 1) refs.current[i + 1]?.focus();
    if (next.every(Boolean)) onComplete(next.join(""));
  };
  return (
    <div className={cn("flex justify-center gap-2", error && "animate-shake")}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => void (refs.current[i] = el)}
          value={d}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          onChange={(e) => update(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
          }}
          className={cn(
            "h-14 w-11 rounded-2xl bg-surface text-center text-2xl font-semibold tabular-nums outline-none ring-accent transition focus:ring-2 sm:w-12",
            error && "ring-2 ring-danger",
          )}
        />
      ))}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5">
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.2 14.6 2.2 12 2.2 6.6 2.2 2.2 6.6 2.2 12s4.4 9.8 9.8 9.8c5.7 0 9.4-4 9.4-9.6 0-.6-.1-1.1-.2-1.6H12z" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.8 1.2 1.8 2.6 3.1 2.6 1.3-.1 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.6-1-2.6-4zM13.9 4.9c.7-.8 1.2-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z" />
    </svg>
  );
}

export function LoginScreen() {
  const [mode, setMode] = useState<"phone" | "email">("phone");
  const [country, setCountry] = useState<string>("US");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"enter" | "code">("enter");
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const dial = COUNTRIES.find((c) => c[0] === country)?.[1] ?? "+1";
  const fullPhone = `${dial}${phone.replace(/\D/g, "").replace(/^0+/, "")}`;
  const providers = ctx.config?.providers;

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function send() {
    setBusy(true);
    try {
      if (mode === "phone") {
        if (!/^\+\d{8,15}$/.test(fullPhone)) throw new Error("Enter a valid phone number");
        await ctx.api.auth.sendPhoneOtp(fullPhone);
      } else {
        if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email address");
        await ctx.api.auth.sendEmailOtp(email.trim().toLowerCase());
      }
      setStep("code");
      setResendIn(60);
      void haptic("success");
    } catch (e) {
      void haptic("error");
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(code: string) {
    setBusy(true);
    setCodeError(false);
    try {
      const r = mode === "phone" ? await ctx.api.auth.verifyPhoneOtp(fullPhone, code) : await ctx.api.auth.verifyEmailOtp(email.trim().toLowerCase(), code);
      if (!r.token) throw new Error("Sign-in failed");
      await signInWithToken(r.token);
      void haptic("success");
    } catch (e) {
      void haptic("warning");
      setCodeError(true);
      toast.error((e as Error).message.includes("OTP") || (e as Error).message.toLowerCase().includes("invalid") ? "That code isn't right" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function social(provider: "google" | "apple") {
    try {
      if (isNative()) {
        // Native: OAuth completes in the system browser and deep-links back with a session token.
        window.open(`${ctx.api.baseUrl}/auth/native?provider=${provider}`, "_system");
        return;
      }
      const r = await ctx.api.auth.social(provider, `${window.location.origin}/?oauth=1`);
      if (r.url) window.location.href = r.url;
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="safe-top safe-bottom flex min-h-full items-center justify-center bg-bg px-6 py-10">
      <motion.div className="w-full max-w-sm" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 300, damping: 30 }}>
        <div className="mb-8 flex flex-col items-center text-center">
          <VeilLogo size={72} />
          <h1 className="mt-5 text-[28px] font-semibold tracking-tight">{step === "code" ? "Enter code" : "Welcome to Veil"}</h1>
          <p className="mt-2 text-[15px] text-muted">
            {step === "code"
              ? `We sent a 6-digit code to ${mode === "phone" ? fullPhone : email}`
              : "Every message, call and file is end-to-end encrypted. Not even we can read them."}
          </p>
        </div>

        {step === "enter" ? (
          <div className="space-y-4">
            <Segmented value={mode} onChange={setMode} options={[{ value: "phone", label: "Phone" }, { value: "email", label: "Email" }]} />
            {mode === "phone" ? (
              <div className="flex gap-2">
                <select
                  aria-label="Country code"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="h-11 rounded-xl bg-surface px-2 text-[15px] outline-none"
                >
                  {COUNTRIES.map(([code, d, flag]) => (
                    <option key={code} value={code}>
                      {flag} {d}
                    </option>
                  ))}
                </select>
                <Input
                  className="flex-1"
                  leading={<Phone className="h-4 w-4" />}
                  placeholder="Phone number"
                  inputMode="tel"
                  autoComplete="tel-national"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                />
              </div>
            ) : (
              <Input
                leading={<Mail className="h-4 w-4" />}
                placeholder="you@example.com"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
              />
            )}
            <Button className="w-full" size="lg" loading={busy} onClick={send}>
              Continue
            </Button>
            {(providers?.google || providers?.apple) && (
              <>
                <div className="flex items-center gap-3 py-1 text-xs uppercase tracking-wider text-subtle">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>
                {providers?.google && (
                  <Button variant="outline" className="w-full" size="lg" onClick={() => social("google")}>
                    <GoogleIcon /> Continue with Google
                  </Button>
                )}
                {providers?.apple && (
                  <Button variant="outline" className="w-full bg-text text-bg hover:bg-text/90 hover:text-bg" size="lg" onClick={() => social("apple")}>
                    <AppleIcon /> Sign in with Apple
                  </Button>
                )}
              </>
            )}
            <p className="flex items-center justify-center gap-1.5 pt-2 text-xs text-subtle">
              <Lock className="h-3.5 w-3.5" /> Signal Protocol · Sealed Sender · Zero-knowledge storage
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <OtpInput onComplete={verify} disabled={busy} error={codeError} />
            {busy && (
              <div className="flex justify-center">
                <Spinner />
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <button className="flex items-center gap-1 text-muted hover:text-text" onClick={() => setStep("enter")}>
                <ChevronLeft className="h-4 w-4" /> Change
              </button>
              <button className="text-accent disabled:text-subtle" disabled={resendIn > 0 || busy} onClick={send}>
                {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

/** Squares and downsizes an image to a JPEG avatar before encrypting it. */
export async function prepareAvatar(file: Blob, size = 640): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = Math.min(size, side);
  c.getContext("2d")!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.88));
}

export function useUsernameCheck(value: string, current?: string | null) {
  const [state, setState] = useState<"idle" | "checking" | "available" | "taken" | "invalid">("idle");
  useEffect(() => {
    if (!value || value.toLowerCase() === current?.toLowerCase()) return setState("idle");
    if (!USERNAME_RE.test(value)) return setState("invalid");
    setState("checking");
    const t = setTimeout(async () => {
      try {
        const r = await ctx.api.me.checkUsername(value);
        setState(r.available ? "available" : r.reason === "invalid" ? "invalid" : "taken");
      } catch {
        setState("idle");
      }
    }, 350);
    return () => clearTimeout(t);
  }, [value, current]);
  return state;
}

export function UsernameHint({ state }: { state: ReturnType<typeof useUsernameCheck> }) {
  if (state === "idle") return <p className="px-1 text-xs text-muted">5–32 characters: a–z, 0–9 and underscores.</p>;
  if (state === "checking") return <p className="flex items-center gap-1 px-1 text-xs text-muted"><Spinner className="h-3 w-3" /> Checking…</p>;
  if (state === "available") return <p className="flex items-center gap-1 px-1 text-xs text-accent"><Check className="h-3.5 w-3.5" /> Username is available</p>;
  if (state === "taken") return <p className="flex items-center gap-1 px-1 text-xs text-danger"><X className="h-3.5 w-3.5" /> This username is taken</p>;
  return <p className="px-1 text-xs text-danger">Must start with a letter; 5–32 letters, digits or underscores.</p>;
}

export function OnboardingScreen() {
  const me = ctx.me!;
  const [name, setName] = useState(me.name || "");
  const [lastName, setLastName] = useState(me.lastName ?? "");
  const [username, setUsername] = useState(me.username ?? "");
  const [bio, setBio] = useState(me.bio ?? "");
  const [avatar, setAvatar] = useState<{ mediaId: string; key: string; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const check = useUsernameCheck(username, me.username);

  async function pickAvatar(f: File) {
    setUploading(true);
    try {
      const img = await prepareAvatar(f);
      const up = await uploadEncrypted(img);
      setAvatar({ mediaId: up.mediaId, key: up.key, preview: URL.createObjectURL(img) });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!name.trim()) return toast.error("Please enter your name");
    if (username && check !== "available" && username !== me.username) return toast.error("Choose an available username");
    setBusy(true);
    try {
      await ctx.api.me.update({
        name: name.trim(),
        lastName: lastName.trim(),
        ...(username ? { username } : {}),
        bio,
        ...(avatar ? { avatarMediaId: avatar.mediaId, avatarKey: avatar.key } : {}),
        onboarded: true,
      });
      await refreshMe();
      void haptic("success");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="safe-top safe-bottom flex min-h-full items-center justify-center bg-bg px-6 py-10">
      <motion.div className="w-full max-w-sm space-y-5" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="text-center">
          <h1 className="text-[26px] font-semibold tracking-tight">Your profile</h1>
          <p className="mt-1 text-[15px] text-muted">Choose how others see you on Veil.</p>
        </div>
        <div className="flex justify-center">
          <button className="relative" onClick={() => fileRef.current?.click()} aria-label="Choose photo">
            {avatar ? (
              <img src={avatar.preview} alt="" className="h-28 w-28 rounded-full object-cover" />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Camera className="h-9 w-9" />
              </div>
            )}
            {uploading && (
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
                <Spinner className="text-white" />
              </div>
            )}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && pickAvatar(e.target.files[0])} />
        </div>
        <div className="space-y-3">
          <Input placeholder="First name (required)" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          <Input placeholder="Last name (optional)" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={64} />
          <div className="space-y-1">
            <Input leading={<AtSign className="h-4 w-4" />} placeholder="username" value={username} onChange={(e) => setUsername(e.target.value.trim())} autoCapitalize="off" autoCorrect="off" maxLength={32} />
            <UsernameHint state={check} />
          </div>
          <div className="space-y-1">
            <Textarea rows={2} placeholder="Bio (optional)" value={bio} maxLength={BIO_MAX} onChange={(e) => setBio(e.target.value)} />
            <p className="px-1 text-right text-xs text-muted">{BIO_MAX - bio.length}</p>
          </div>
        </div>
        <Button className="w-full" size="lg" loading={busy} onClick={save}>
          Start messaging
        </Button>
      </motion.div>
    </div>
  );
}

