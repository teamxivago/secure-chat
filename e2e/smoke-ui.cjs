const { chromium } = require("playwright");
(async () => {
  const out = process.env.SHOTS;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
  await page.goto("http://localhost:3000/", { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/01-login-mobile.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/01-login-desktop.png` });
  console.log("ERRORS:", JSON.stringify(errors, null, 1));
  await browser.close();
})();
