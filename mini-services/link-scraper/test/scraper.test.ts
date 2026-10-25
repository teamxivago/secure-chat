import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../src/net";
import { parseHtml } from "../src/preview";

describe("ssrf guard", () => {
  it("blocks private and special ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("open graph parsing", () => {
  it("extracts og fields and resolves relative urls", () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Hello &amp; world">
      <meta property="og:description" content="A   description">
      <meta property="og:image" content="/img/cover.jpg">
      <meta property="og:site_name" content="Example">
      <link rel="icon" href="/favicon.png"></head></html>`;
    const p = parseHtml(html, "https://example.com/post/1");
    expect(p.title).toBe("Hello & world");
    expect(p.description).toBe("A description");
    expect(p.image).toBe("https://example.com/img/cover.jpg");
    expect(p.favicon).toBe("https://example.com/favicon.png");
    expect(p.siteName).toBe("Example");
  });
  it("rejects javascript: image urls", () => {
    const p = parseHtml(`<meta property="og:image" content="javascript:alert(1)">`, "https://e.com");
    expect(p.image).toBeUndefined();
  });
});
