// Renders PNG app icons/splash from the SVG logo using headless Chromium.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "../apps/web/public/icons/icon.svg"), "utf8");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = process.argv[2] || path.join(__dirname, "../apps/web/public/icons");
  for (const size of [192, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(out, `icon-${size}.png`), omitBackground: true });
  }
  // Square splash (2732²) for Capacitor: logo centered on the dark brand background.
  await page.setViewportSize({ width: 2732, height: 2732 });
  await page.setContent(`<html><body style="margin:0;background:#0F0F1A;display:flex;align-items:center;justify-content:center;height:2732px">${svg.replace("<svg ", '<svg width="560" height="560" ')}</body></html>`);
  await page.screenshot({ path: path.join(out, "splash.png") });
  await browser.close();
  console.log("icons rendered to", out);
})();
