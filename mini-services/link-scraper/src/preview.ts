import { load } from "cheerio";
import { classifyUrl, youtubeId, type LinkPreview } from "@veil/shared";
import { safeFetch } from "./net";

const clip = (s: string | undefined | null, n: number) => {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function absolute(u: string | undefined, base: string) {
  if (!u) return undefined;
  try {
    const r = new URL(u, base);
    return r.protocol === "https:" || r.protocol === "http:" ? r.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseHtml(html: string, finalUrl: string): Omit<LinkPreview, "url" | "kind"> {
  const $ = load(html);
  const meta = (...names: string[]) => {
    for (const n of names) {
      const v = $(`meta[property="${n}"]`).attr("content") ?? $(`meta[name="${n}"]`).attr("content");
      if (v) return v;
    }
    return undefined;
  };
  const icon =
    $('link[rel="apple-touch-icon"]').attr("href") ??
    $('link[rel="icon"]').attr("href") ??
    $('link[rel="shortcut icon"]').attr("href") ??
    "/favicon.ico";
  return {
    title: clip(meta("og:title", "twitter:title") ?? $("title").first().text(), 300),
    description: clip(meta("og:description", "twitter:description", "description"), 1000),
    siteName: clip(meta("og:site_name", "application-name") ?? new URL(finalUrl).hostname.replace(/^www\./, ""), 100),
    image: absolute(meta("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"), finalUrl),
    favicon: absolute(icon, finalUrl),
    author: clip(meta("author", "article:author", "twitter:creator"), 200),
  };
}

async function oembed(endpoint: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await safeFetch(endpoint, { maxBytes: 200_000, accept: "application/json" });
    if (r.status !== 200) return null;
    return JSON.parse(r.body.toString("utf8"));
  } catch {
    return null;
  }
}

export async function buildPreview(url: string): Promise<LinkPreview> {
  const kind = classifyUrl(url);

  if (kind === "youtube") {
    const id = youtubeId(url);
    const o = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (o) {
      return {
        url,
        kind,
        title: clip(o.title as string, 300),
        author: clip(o.author_name as string, 200),
        siteName: "YouTube",
        image: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : (o.thumbnail_url as string),
        favicon: "https://www.youtube.com/s/desktop/favicon.ico",
        videoId: id ?? undefined,
      };
    }
  }

  if (kind === "twitter") {
    const o = await oembed(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(url.replace("x.com", "twitter.com"))}`);
    if (o?.html) {
      const $ = load(o.html as string);
      const text = $("blockquote p").first().text();
      const fallback = await safeFetch(url, { maxBytes: 600_000, userAgent: "facebookexternalhit/1.1" }).then((r) => parseHtml(r.body.toString("utf8"), r.url)).catch(() => null);
      return {
        url,
        kind,
        title: clip(o.author_name as string, 200),
        author: clip(`@${String(o.author_url ?? "").split("/").pop()}`, 200),
        description: clip(text, 1000),
        siteName: "X (Twitter)",
        image: fallback?.image,
        favicon: "https://abs.twimg.com/favicons/twitter.3.ico",
      };
    }
  }

  // Instagram (and many sites) only serve Open Graph tags to known crawler user agents.
  const ua = kind === "instagram" || kind === "twitter" ? "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" : undefined;
  const r = await safeFetch(url, { maxBytes: 600_000, accept: "text/html,application/xhtml+xml", userAgent: ua });
  if (r.status >= 400) throw new Error(`upstream status ${r.status}`);
  if (r.contentType.startsWith("image/")) {
    return { url, kind: "generic", image: url, siteName: new URL(r.url).hostname.replace(/^www\./, "") };
  }
  if (!r.contentType.includes("html")) throw new Error("not an html page");
  const parsed = parseHtml(r.body.toString("utf8"), r.url);
  if (kind === "instagram") {
    parsed.siteName = "Instagram";
    parsed.favicon ??= "https://www.instagram.com/static/images/ico/favicon.ico/36b3ee2d91ed.ico";
  }
  return { url, kind, ...parsed };
}
