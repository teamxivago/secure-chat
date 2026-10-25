/**
 * End-to-end test with two real browser users (separate contexts = separate devices).
 * Run: SHOTS=dir node e2e/full.cjs   (requires all services + DEV_EXPOSE_OTP=1)
 */
const { chromium } = require("playwright");
const postgres = require(require.resolve("postgres", { paths: [__dirname + "/.."] }));
const { API, signUp, shot, watch } = require("./helpers.cjs");

const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`✅ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push(`❌ ${name}: ${e.message.split("\n")[0]}`);
    throw e;
  }
};

(async () => {
  const stamp = Date.now().toString(36);
  const A = { email: `alice.${stamp}@example.com`, name: "Alice", username: `alice_${stamp}` };
  const B = { email: `bob.${stamp}@example.com`, name: "Bob", username: `bob_${stamp}` };
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const errors = [];
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  watch(a, "alice", errors);
  watch(b, "bob", errors);
  if (process.env.TRACE) {
    for (const [p, n] of [[a, "A"], [b, "B"]]) {
      await p.addInitScript(() => localStorage.setItem("veil:trace", "1"));
      p.on("console", (m) => m.text().startsWith("[trace]") && console.log(n, m.text()));
    }
  }
  const sql = postgres(process.env.DATABASE_URL);

  try {
    await step("Alice signs up with email OTP + onboarding", () => signUp(a, A));
    await step("Bob signs up with email OTP + onboarding", () => signUp(b, B));
    await shot(a, "10-alice-empty");

    await step("Alice finds Bob by username (global search)", async () => {
      await a.getByTestId("global-search").click();
      await a.getByTestId("global-search-input").fill(B.username);
      await a.getByTestId("search-user").first().click();
      await a.getByTestId("chat-title").filter({ hasText: "Bob" }).waitFor();
    });

    const secret = `Hello Bob 🔐 ${stamp}`;
    let t0;
    await step("Alice sends an E2EE message", async () => {
      await a.getByTestId("composer").fill(secret);
      t0 = Date.now();
      await a.getByTestId("send").click();
      await a.locator("[data-mid]").filter({ hasText: secret }).waitFor();
    });

    await step("Bob receives it in the chat list and opens it", async () => {
      await b.getByTestId("chat-row").filter({ hasText: secret }).waitFor({ timeout: 15000 });
      results.push(`   ⏱ delivery to Bob's chat list: ${Date.now() - t0}ms`);
      await shot(b, "11-bob-chatlist");
      await b.getByTestId("chat-row").filter({ hasText: "Alice" }).click();
      await b.locator("[data-mid]").filter({ hasText: secret }).waitFor();
    });

    await step("Bob replies; Alice sees reply and read receipts", async () => {
      await b.getByTestId("composer").fill("Hi Alice! Received securely ✅");
      await b.getByTestId("send").click();
      await a.locator("[data-mid]").filter({ hasText: "Received securely" }).waitFor({ timeout: 15000 });
      await shot(a, "12-alice-conversation");
      await shot(b, "12-bob-conversation");
    });

    await step("Steady-state latency (10 messages, chat open on both sides)", async () => {
      const times = [];
      await b.evaluate(() => {
        window.__seen = {};
        new MutationObserver(() => {
          for (const el of document.querySelectorAll("[data-mid]")) {
            const m = el.textContent.match(/lat-(\d+)-/);
            if (m && !window.__seen[m[1]]) window.__seen[m[1]] = Date.now();
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      for (let i = 0; i < 10; i++) {
        await a.getByTestId("composer").fill(`lat-${i}-${stamp}`);
        await a.getByTestId("send").waitFor();
        const t0 = await a.evaluate(() => {
          const t = Date.now();
          document.querySelector('[data-testid="send"]').click();
          return t;
        });
        await b.waitForFunction((k) => !!window.__seen[k], String(i), { timeout: 10000 });
        times.push((await b.evaluate((k) => window.__seen[k], String(i))) - t0);
        await a.waitForTimeout(150);
      }
      const sorted = [...times].sort((x, y) => x - y);
      results.push(`   ⏱ Alice click → Bob render, ms: ${times.join(", ")} | median ${sorted[5]} | p90 ${sorted[8]}`);
    });

    await step("Database holds only ciphertext (no plaintext anywhere)", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const needle = Buffer.from(secret);
      const env = await sql`select count(*)::int n from envelope where position(${needle} in content) > 0`;
      const vault = await sql`select count(*)::int n from vault_record where data like ${"%" + "Hello Bob" + "%"}`;
      const vaultRows = await sql`select count(*)::int n from vault_record`;
      if (env[0].n || vault[0].n) throw new Error(`plaintext found: envelope=${env[0].n} vault=${vault[0].n}`);
      if (!vaultRows[0].n) throw new Error("vault not written");
      results.push(`   🔒 vault rows (all AES-GCM sealed): ${vaultRows[0].n}`);
    });


    const bubble = (page, text) => page.locator("[data-mid]").filter({ hasText: text }).last();
    const openMenu = async (page, text) => {
      await bubble(page, text).locator(".no-select").first().click({ button: "right" });
    };

    await step("Bob reacts 👍 — Alice sees the reaction", async () => {
      await openMenu(b, secret);
      await b.getByRole("button", { name: "👍" }).first().click();
      await bubble(a, secret).getByText("👍").waitFor({ timeout: 10000 });
    });

    await step("Alice edits her message — Bob sees new text + 'edited'", async () => {
      await openMenu(a, secret);
      await a.getByRole("button", { name: "Edit", exact: true }).click();
      await a.getByTestId("composer").fill(`${secret} (edited text)`);
      await a.getByTestId("send").click();
      await bubble(b, "(edited text)").getByText("edited", { exact: true }).waitFor({ timeout: 10000 });
    });

    await step("Delete for everyone removes the message on both sides", async () => {
      const tmp = `temporary ${stamp}`;
      await a.getByTestId("composer").fill(tmp);
      await a.getByTestId("send").click();
      await bubble(b, tmp).waitFor({ timeout: 10000 });
      await openMenu(a, tmp);
      await a.getByRole("button", { name: "Delete" }).click();
      await a.getByLabel("Also delete for the other person").check();
      await a.getByRole("button", { name: "Delete", exact: true }).last().click();
      await bubble(b, tmp).waitFor({ state: "detached", timeout: 10000 });
    });

    await step("Encrypted photo: upload, deliver, decrypt on Bob's device", async () => {
      const png = require("path").join(__dirname, "../apps/web/public/icons/icon-512.png");
      await a.locator('input[type=file][accept="image/*,video/*"]:not([capture])').setInputFiles(png);
      await a.getByPlaceholder("Add a caption…").fill(`photo ${stamp}`);
      await a.getByRole("button", { name: "Send", exact: true }).click();
      await bubble(b, `photo ${stamp}`).locator('img[src^="blob:"]').waitFor({ timeout: 20000 });
      const [m] = await sql`select object_key, size from media order by created_at desc limit 1`;
      const file = require("fs").readFileSync(require("path").join(__dirname, "../mini-services/media-worker/.data/media", m.object_key));
      const isPng = file.subarray(1, 4).toString() === "PNG";
      if (isPng) throw new Error("stored blob is plaintext PNG!");
      results.push(`   🔒 stored blob ${m.size} bytes, first bytes ${file.subarray(0, 8).toString("hex")} (ciphertext, not PNG)`);
      await shot(b, "13-bob-photo");
    });

    await step("Alice creates a group with Bob (Sender Keys) and messages it", async () => {
      await a.getByRole("button", { name: "New message" }).first().click();
      await a.getByText("New group", { exact: true }).click();
      await a.getByPlaceholder("Search", { exact: true }).fill(B.username);
      await a.getByTestId("pick-user").first().click();
      await a.getByRole("button", { name: "Next", exact: true }).click();
      await a.getByPlaceholder("Group name").fill(`Crypto Club ${stamp}`);
      await a.getByRole("button", { name: "Create group", exact: true }).click();
      await a.getByTestId("chat-title").filter({ hasText: "Crypto Club" }).waitFor();
      await a.getByTestId("composer").fill(`group hello ${stamp}`);
      await a.getByTestId("send").click();
      await b.getByRole("button", { name: "Back" }).first().click({ timeout: 1500 }).catch(() => {});
      await b.getByTestId("chat-row").filter({ hasText: "Crypto Club" }).click({ timeout: 15000 });
      await bubble(b, `group hello ${stamp}`).waitFor({ timeout: 15000 });
      const g = await sql`select count(*)::int n from group_message where position(${Buffer.from("group hello")} in ciphertext) > 0`;
      if (g[0].n) throw new Error("group plaintext stored");
      await shot(b, "14-bob-group");
    });

    await step("Poll in group: Bob votes, Alice sees the result", async () => {
      await a.getByRole("button", { name: "Attach", exact: true }).click();
      await a.getByRole("button", { name: "Poll", exact: true }).click();
      await a.getByPlaceholder("Ask a question").fill("Best cipher?");
      await a.getByPlaceholder("Option 1").fill("AES-256");
      await a.getByPlaceholder("Option 2").fill("ChaCha20");
      await a.getByRole("button", { name: "Create poll" }).click();
      await bubble(b, "Best cipher?").getByRole("button", { name: "ChaCha20" }).click({ timeout: 15000 });
      await bubble(a, "Best cipher?").getByText("1 vote").waitFor({ timeout: 10000 });
      await shot(a, "15-alice-poll");
    });

    await step("Voice call Alice → Bob connects over WebRTC and ends", async () => {
      await a.getByRole("button", { name: "Back" }).first().click({ timeout: 1500 }).catch(() => {});
      await a.getByTestId("chat-row").filter({ hasText: "Bob" }).click();
      await a.getByRole("button", { name: "Voice call" }).click();
      await b.getByTestId("call-overlay").waitFor({ timeout: 15000 });
      await b.getByRole("button", { name: "Accept", exact: true }).click();
      await a.getByTestId("call-overlay").getByText(/^0:0\d$/).waitFor({ timeout: 20000 });
      await shot(a, "16-alice-call");
      await a.getByRole("button", { name: "End", exact: true }).click();
      await a.getByTestId("call-overlay").waitFor({ state: "detached", timeout: 10000 });
    });

    await step("App lock: set passcode, reload, unlock with PIN pad", async () => {
      await a.getByTestId("tab-settings").click();
      await a.getByText("Privacy and Security").click();
      await a.getByRole("switch", { name: "Passcode lock" }).click();
      for (const round of [0, 1]) {
        for (const d of "1234") await a.getByRole("button", { name: d, exact: true }).click();
        if (round === 0) await a.getByRole("button", { name: "OK" }).click();
        await a.waitForTimeout(300);
      }
      await a.reload();
      await a.getByTestId("app-lock").waitFor({ timeout: 15000 });
      await shot(a, "17-app-lock");
      for (const d of "1234") await a.getByRole("button", { name: d, exact: true }).click();
      await a.getByTestId("tab-chats").waitFor({ timeout: 15000 });
    });

    await step("Second device: link via approval, history syncs from encrypted vault", async () => {
      const ctxA2 = await browser.newContext({ viewport: { width: 1100, height: 760 } });
      const a2 = await ctxA2.newPage();
      watch(a2, "alice-2", errors);
      if (process.env.TRACE) {
        await a2.addInitScript(() => localStorage.setItem("veil:trace", "1"));
        a2.on("console", (m) => (m.text().startsWith("[trace]") || m.type() === "warning") && console.log("A2", m.text()));
      }
      await a2.goto(API + "/");
      await a2.getByRole("button", { name: "Email" }).click();
      await a2.getByPlaceholder("you@example.com").fill(A.email);
      await a2.getByRole("button", { name: "Continue" }).click();
      const { otpFor, typeOtp } = require("./helpers.cjs");
      await typeOtp(a2, await otpFor(A.email));
      const code = (await a2.getByTestId("link-code").textContent({ timeout: 20000 })).trim();
      await shot(a2, "18-device2-link");
      await a.getByTestId("tab-settings").click();
      await a.getByRole("button", { name: "Back" }).first().click({ timeout: 1500 }).catch(() => {});
      await a.getByText("Devices", { exact: true }).click();
      await a.getByText(code).waitFor({ timeout: 15000 });
      await a.locator("div.flex.items-center.gap-3").filter({ hasText: code }).getByRole("button", { name: "Approve", exact: true }).click();
      await a2.getByTestId("tab-chats").waitFor({ timeout: 20000 });
      await a2.getByTestId("chat-row").filter({ hasText: "Bob" }).click({ timeout: 20000 });
      await bubble(a2, "(edited text)").waitFor({ timeout: 20000 });
      await bubble(a2, `photo ${stamp}`).locator('img[src^="blob:"]').waitFor({ timeout: 20000 });
      await shot(a2, "19-device2-history");
      // New messages now fan out to both of Alice's devices.
      await b.getByRole("button", { name: "Back" }).first().click({ timeout: 1500 }).catch(() => {});
      await b.getByTestId("chat-row").filter({ hasText: "Alice" }).first().click();
      await b.waitForTimeout(600); // let the previous chat view finish its exit animation
      await b.getByTestId("composer").last().fill(`to both devices ${stamp}`);
      await b.getByTestId("send").last().click();
      await bubble(a2, `to both devices ${stamp}`).waitFor({ timeout: 15000 });
      await ctxA2.close();
    });
    console.log(results.join("\n"));
    if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.join("\n"));
  } catch (e) {
    console.log(results.join("\n"));
    console.log("CONSOLE ERRORS:\n" + errors.join("\n"));
    await shot(a, "fail-alice").catch(() => {});
    await shot(b, "fail-bob").catch(() => {});
    console.error(e);
    process.exitCode = 1;
  } finally {
    await sql.end();
    await browser.close();
  }
})();
