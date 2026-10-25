"use client";
import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

/** Camera QR scanner (works in browsers and Capacitor WebViews via getUserMedia). */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const tick = () => {
          if (done) return;
          const c = canvas.current!;
          if (v.readyState === v.HAVE_ENOUGH_DATA) {
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const g = c.getContext("2d", { willReadFrequently: true })!;
            g.drawImage(v, 0, 0);
            const img = g.getImageData(0, 0, c.width, c.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (code?.data) {
              done = true;
              onResult(code.data);
              return;
            }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setError("Camera access is required to scan the code");
      }
    })();
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
      <video ref={video} className="h-full w-full object-cover" muted playsInline />
      <canvas ref={canvas} className="hidden" />
      <div className="pointer-events-none absolute inset-10 rounded-3xl border-4 border-white/80" />
      {error && <p className="absolute inset-x-0 bottom-4 text-center text-sm text-white">{error}</p>}
    </div>
  );
}
