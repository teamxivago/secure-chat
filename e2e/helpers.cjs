const API = process.env.API ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? "/tmp";

const lastCodes = {};
async function otpFor(dest) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${API}/api/dev/otp?to=${encodeURIComponent(dest)}`);
    const { code } = await r.json();
    // Wait for a fresh code when this address already received one earlier in the run.
    if (code && code !== lastCodes[dest]) return (lastCodes[dest] = code);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("no OTP for " + dest);
}

async function typeOtp(page, code) {
  const first = page.getByLabel("Digit 1");
  await first.waitFor();
  await first.fill(code); // paste-style fill distributes across boxes
}

async function signUp(page, { email, name, username }) {
  await page.goto(API + "/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Email" }).click();
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await typeOtp(page, await otpFor(email));
  await page.getByPlaceholder("First name (required)").waitFor({ timeout: 30000 });
  await page.getByPlaceholder("First name (required)").fill(name);
  await page.getByPlaceholder("username").fill(username);
  await page.getByText("Username is available").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Start messaging" }).click();
  await page.getByTestId("tab-chats").waitFor({ timeout: 30000 });
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

function watch(page, label, errors) {
  page.on("pageerror", (e) => errors.push(`[${label}] PAGEERROR ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon|WebSocket/i.test(m.text())) errors.push(`[${label}] ${m.text()}`);
  });
}

module.exports = { API, SHOTS, otpFor, typeOtp, signUp, shot, watch };
