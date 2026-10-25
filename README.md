# Veil — end-to-end encrypted messenger

A Telegram-class messenger where every message, file, call and reaction is end-to-end
encrypted with the Signal Protocol. Next.js 16 web/PWA + Capacitor 6 iOS/Android, one shared
client, Postgres + Redis backend split into small services.

```
apps/
  web/            Next.js 16 — REST API (route handlers), better-auth, web/PWA client
  mobile/         Next.js static export + Capacitor 6 (android/, ios/, plugins/secure-screen)
packages/
  crypto/         X3DH, Double Ratchet, Sealed Sender, Sender Keys, media/vault/OPRF crypto
  shared/         E2EE payload schemas (zod), API DTOs, constants, utils
  database/       Drizzle ORM schema + migrations (PostgreSQL)
  api-client/     typed fetch client (cookie on web, bearer token in native apps)
  ui/             the whole client: encrypted local store, messaging engine, calls, all screens
mini-services/
  chat-ws/        Socket.IO + Redis adapter: sealed 1:1 envelopes, group fan-out, presence
  media-worker/   signed R2 (S3) multipart URLs for ciphertext blobs; once-view/expiry purge
  push-service/   FCM, APNs (HTTP/2 token auth), Web Push; DND/quiet-hours/mute policy
  link-scraper/   Open Graph/oEmbed previews (7-day cache), SSRF-safe fetch, image/tile proxy, GIFs
  call-signaling/ WebRTC call lifecycle, E2EE SDP/ICE relay, TURN credentials
e2e/              Playwright two-user end-to-end suite
```

## Security model

| Data | What the server stores |
|---|---|
| 1:1 messages, reactions, edits, receipts, typing, poll votes, RSVPs | Double Ratchet ciphertext per recipient device inside **sealed sender** envelopes (no sender column), deleted on ack |
| Group/channel messages | one Sender Keys ciphertext per message; the sender is stored only as `HMAC(pepper, user:chat)` |
| Media (photos, video ≤2 GB, files, voice) | AES-256-CBC + HMAC-SHA256 chunks encrypted on device (8 MiB parts → R2 multipart); the key travels only inside the E2EE message |
| Multi-device history, drafts, chat settings, contact names | AES-256-GCM records under the **Account Storage Key**, which only linked devices hold |
| Keys | public halves only (identity, signed pre-key, one-time pre-keys) |
| Contact discovery | OPRF (RFC 9497, ristretto255) blinded tokens — raw or hashed phone numbers never sent |

* **New devices** get history only after an existing device approves them (QR scan or a matching
  6-digit code), which transfers the account key encrypted to the new device. The alternative is
  a user-held recovery key (scrypt-wrapped backup). An SMS-only takeover receives nothing.
* **Terminating a session** deletes its device, keys and session, and the device wipes its local store.
* The local store is IndexedDB, with every value sealed under a non-extractable WebCrypto key.
* The app lock is a PBKDF2-hashed PIN plus biometrics. It locks on launch and on resume after a
  timeout, with escalating lockouts.
* **Screenshot protection:** Android `FLAG_SECURE` is set from the first frame, with Android 14
  screenshot detection. iOS renders inside a secure text-field layer, detects capture and blurs the
  app switcher. Once-view media also self-destructs (server TTL plus recipient delete token) and
  notifies the sender of capture attempts.
* The web app ships a strict nonce-based CSP, HSTS, frame-deny and no-referrer headers. The API
  validates every input with zod, is rate-limited (OTP, search, OPRF, sends) and allows CORS only
  for the app origins.

### Deliberate deviations from a naive reading of the spec
* **Message search is on-device** (`packages/ui/src/engine/search.ts`). A server index
  (Meilisearch) would require plaintext. Meilisearch/Postgres trigram is used only for the public
  directory (usernames, public groups and channels).
* **Push notifications carry no content and, for 1:1 chats, no sender name.** Sealed sender means
  the server does not know who sent a message. Group pushes do name the sender, because group
  permissions (admin-only posting, slow mode) require the server to know who is posting.
* **Group metadata** (title, members, roles) is server-visible, as in Telegram, because the server
  enforces permissions, invite links and join requests. 1:1 relationships are not stored at all.
* **Group calls are a full mesh** (≤32 participants). That is practical for audio and small video
  groups. Larger video calls would need an SFU (mediasoup with insertable-streams E2EE), which is
  not included.

## Running locally

```bash
pnpm install
docker compose up -d postgres redis     # or local Postgres 16 + Redis 7
cp .env.example .env && pnpm secrets >> .env   # then set dev values, e.g.:
#   SMS_PROVIDER=console EMAIL_PROVIDER=console STORAGE_DRIVER=local DEV_EXPOSE_OTP=1
#   APP_URL=http://localhost:3000 PUBLIC_CHAT_WS_URL=http://localhost:4001 PUBLIC_CALL_WS_URL=http://localhost:4005
set -a; . ./.env; set +a
pnpm db:migrate && pnpm db:seed
./scripts/dev-all.sh        # web :3000, chat-ws :4001, media :4002, link :4003, calls :4005, push
./scripts/stop-all.sh
```

In dev, OTP codes are printed in `.logs/web.log`.

## Tests

```bash
pnpm --filter @veil/crypto test          # 12 protocol tests (X3DH, ratchet incl. out-of-order/replay/tamper,
                                         #   simultaneous init, sealed sender, sender keys + rotation,
                                         #   chunked media, vault, provisioning, OPRF)
pnpm --filter @veil/link-scraper test    # SSRF guard + OG parsing
pnpm --filter @veil/push-service test    # notification policy (quiet hours, mentions, mute)
npx tsx scripts/smoke.ts                 # headless sealed-sender exchange + DB ciphertext check
SHOTS=/tmp node e2e/full.cjs             # two-browser E2E (needs DEV_EXPOSE_OTP=1, raised OTP limits)
```

`e2e/full.cjs` runs 17 steps in real Chromium: email-OTP sign-up and onboarding, username
search, E2EE chat both ways, a DB check for plaintext, reactions, edit, delete-for-everyone, an
encrypted photo (the stored blob is verified to be ciphertext), a group with Sender Keys, a poll,
a WebRTC voice call, the app lock, and linking a second device that receives full history from the
vault and decrypts the photo. Click-to-render latency between two users is about 150–400 ms median,
depending on host speed.

## Mobile

```bash
cd apps/mobile
NEXT_PUBLIC_API_URL=https://api.veil.app pnpm cap:sync
pnpm cap:android     # Android Studio; add android/app/google-services.json for FCM
pnpm cap:ios         # Xcode on macOS (pod install); enable Push + Associated Domains capabilities
```

The native projects are configured with permissions and usage strings, `veil://` and
`https://veil.app/join/*` deep links, backup exclusion of key material, push delegates, icons,
splash screens, and the custom `SecureScreen` plugin (`plugins/secure-screen`, Java + Swift).
Native Google and Apple sign-in use a system-browser OAuth handoff (`/auth/native`) that
deep-links the session token back to the app.

## Status: verified vs. needs your credentials/hardware

**Verified here (Linux container):**
* every package typechecks
* unit tests pass
* the web production build succeeds
* the mobile static export builds
* `cap add android/ios` generates the projects
* the full two-user browser E2E suite passes

**Not verified (blocked by this environment):**
* **Native compilation.** The Android SDK and Gradle plugins can't be downloaded here (egress
  blocked), and iOS needs Xcode on macOS, so the Java/Swift plugin code and both app builds have
  not been compiled.
* **External providers.** Twilio/MSG91 SMS, SMTP, Google/Apple OAuth, Cloudflare R2, FCM, APNs,
  GIPHY/Tenor, Cloudflare TURN and Meilisearch are fully wired but need your keys. Locally they
  run with dev substitutes: console OTP, local-disk blob storage, STUN-only ICE and Postgres search.
* **Live link previews.** Outbound fetches to Instagram/X/YouTube were not exercised from this sandbox.
* **Load.** 200k-member groups are supported by design (paginated fan-out, sender keys), but not
  load-tested.
