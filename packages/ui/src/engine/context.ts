import { createApiClient, type ApiClient, type PublicConfig } from "@veil/api-client";
import type { MeUser } from "@veil/shared";
import { kvGet, kvSet } from "../lib/db";
import { IdbProtocolStore } from "./protocol-store";

/** Process-wide engine state (one account per app instance). */

export interface Account {
  userId: string;
  deviceId: string | null;
  token: string;
  status: "pending" | "active" | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __VEIL_API_BASE__: string | undefined;
}

export const apiBase = () =>
  (typeof window !== "undefined" && (globalThis.__VEIL_API_BASE__ ?? process.env.NEXT_PUBLIC_API_URL)) || "";

class Ctx {
  account: Account | null = null;
  me: MeUser | null = null;
  config: PublicConfig | null = null;
  accountKey: Uint8Array | null = null;
  store = new IdbProtocolStore();
  private _api: ApiClient | null = null;

  get api(): ApiClient {
    this._api ??= createApiClient({
      baseUrl: apiBase(),
      getToken: () => this.account?.token ?? null,
      onToken: (t) => {
        if (this.account && this.account.token !== t) {
          this.account.token = t;
          void kvSet("account", this.account);
        }
      },
    });
    return this._api;
  }

  get userId() {
    if (!this.account) throw new Error("not signed in");
    return this.account.userId;
  }
  get deviceId() {
    if (!this.account?.deviceId) throw new Error("device not registered");
    return this.account.deviceId;
  }
  get selfAddress() {
    return `${this.userId}.${this.deviceId}`;
  }
  /** Active = approved by the server AND holding the account key (provisioning completed). */
  get active() {
    return this.account?.status === "active" && !!this.accountKey;
  }

  async loadPersisted() {
    this.account = (await kvGet<Account>("account")) ?? null;
    this.accountKey = (await kvGet<Uint8Array>("ask")) ?? null;
    this.me = (await kvGet<MeUser>("me")) ?? null;
  }

  async saveAccount() {
    await kvSet("account", this.account);
  }

  /** Resolves URLs of mini-services (proxied through the web origin by default). */
  svc(path: "media" | "link"): string {
    const base = path === "media" ? this.config?.mediaUrl : this.config?.linkUrl;
    const v = base ?? `/svc/${path}`;
    return v.startsWith("http") ? v : apiBase() + v;
  }
}

export const ctx = new Ctx();
