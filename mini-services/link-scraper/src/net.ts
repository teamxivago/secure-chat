import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, ProxyAgent, fetch, type Dispatcher } from "undici";

/**
 * SSRF-safe outbound fetching. Every resolved address is checked at connect time (defeats DNS
 * rebinding), only http(s) on standard ports, bounded redirects, size and time limits.
 */

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("2001:db8");
}

function guardedLookup(hostname: string, options: object, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as { address: string; family: number }[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return cb(new Error("blocked address"), []);
    if ((options as { all?: boolean }).all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

async function assertPublicHost(hostname: string) {
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("blocked address");
    return;
  }
  await new Promise<void>((res, rej) => guardedLookup(hostname, {}, (e) => (e ? rej(e) : res())));
}

const proxyUrl = process.env.SCRAPER_HTTPS_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
const dispatcher: Dispatcher = proxyUrl
  ? new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: true } })
  : new Agent({ connect: { lookup: guardedLookup as never, timeout: 5000 }, headersTimeout: 8000, bodyTimeout: 8000 });

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export async function safeFetch(rawUrl: string, opts: { maxBytes: number; accept?: string; userAgent?: string; maxRedirects?: number }): Promise<SafeResponse> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 4); hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) throw new Error("blocked port");
    if (url.username || url.password) throw new Error("credentials in URL");
    // With an upstream proxy the proxy connects, so validate resolution up front as well.
    await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ""));
    const res = await fetch(url, {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": opts.userAgent ?? "Mozilla/5.0 (compatible; VeilLinkPreview/1.0; +https://veil.app/bot)",
        Accept: opts.accept ?? "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      await res.body?.cancel();
      continue;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > opts.maxBytes) {
      await res.body?.cancel();
      throw new Error("response too large");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > opts.maxBytes) {
          if (opts.accept?.startsWith("text/html")) break; // the <head> is enough for previews
          throw new Error("response too large");
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    return { url: url.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks) };
  }
  throw new Error("too many redirects");
}
