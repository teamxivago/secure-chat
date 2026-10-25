import type {
  ChatMemberInfo,
  ChatSummary,
  DeviceInfo,
  GroupMessageWire,
  MeUser,
  PreKeyBundleWireT,
  PublicUser,
} from "@veil/shared";

/**
 * Typed API client shared by the web app and the Capacitor app.
 * Web uses same-origin cookies; native uses a bearer session token (better-auth bearer plugin).
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  baseUrl: string; // "" for same-origin
  getToken?: () => string | null;
  onToken?: (token: string) => void;
  onUnauthorized?: () => void;
}

export interface PublicConfig {
  trustRoot: string | null;
  chatWsUrl: string;
  callWsUrl: string;
  mediaUrl: string;
  linkUrl: string;
  providers: { google: boolean; apple: boolean; phone: boolean; email: boolean };
  gifs: boolean;
  contactDiscovery: boolean;
}

export interface StickerPackDto {
  id: string;
  name: string;
  title: string;
  installed: boolean;
  stickers: { id: string; emoji: string; url: string; mime: string }[];
}

export interface InviteDto {
  id: string;
  token: string;
  name: string | null;
  expiresAt: number | null;
  usageLimit: number;
  usageCount: number;
  requiresApproval: boolean;
  revoked: boolean;
  isPrimary: boolean;
  createdAt: number;
}

export interface DirectorySearch {
  users: PublicUser[];
  chats: { id: string; type: string; title: string; username: string | null; description: string | null; memberCount: number; avatarMediaId: string | null; avatarKey: string | null }[];
}

export function createApiClient(opts: ApiClientOptions) {
  async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = opts.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(opts.baseUrl + path, {
      method,
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: opts.baseUrl ? "include" : "same-origin",
      signal: init?.signal,
    });
    const newToken = res.headers.get("set-auth-token");
    if (newToken) opts.onToken?.(newToken);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.();
      throw new ApiError(res.status, (data as { error?: string; message?: string })?.error ?? (data as { message?: string })?.message ?? res.statusText, data);
    }
    return data as T;
  }

  const get = <T>(p: string, init?: RequestInit) => request<T>("GET", p, undefined, init);
  const post = <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {});
  const put = <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {});
  const patch = <T>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {});
  const del = <T>(p: string, b?: unknown) => request<T>("DELETE", p, b);
  const q = (o: Record<string, string | number | undefined | null>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
    const r = s.toString();
    return r ? `?${r}` : "";
  };
  const e = encodeURIComponent;

  return {
    request,
    baseUrl: opts.baseUrl,
    config: () => get<PublicConfig>("/api/config"),

    auth: {
      sendPhoneOtp: (phoneNumber: string) => post<{ status: boolean }>("/api/auth/phone-number/send-otp", { phoneNumber }),
      verifyPhoneOtp: (phoneNumber: string, code: string) =>
        post<{ status: boolean; token: string | null; user: { id: string } }>("/api/auth/phone-number/verify", { phoneNumber, code, disableSession: false }),
      sendEmailOtp: (email: string) => post<{ success: boolean }>("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
      verifyEmailOtp: (email: string, otp: string) => post<{ token: string; user: { id: string } }>("/api/auth/sign-in/email-otp", { email, otp }),
      social: (provider: "google" | "apple", callbackURL: string, idToken?: { token: string; nonce?: string }) =>
        post<{ url?: string; redirect: boolean; token?: string }>("/api/auth/sign-in/social", { provider, callbackURL, ...(idToken ? { idToken } : {}) }),
      session: () => get<{ session: { id: string; token: string; userId: string }; user: { id: string } } | null>("/api/auth/get-session"),
      signOut: () => post<{ success: boolean }>("/api/auth/sign-out"),
    },

    me: {
      get: () => get<MeUser>("/api/me"),
      update: (b: Record<string, unknown>) => patch<MeUser>("/api/me", b),
      checkUsername: (u: string) => get<{ available: boolean; reason?: string }>(`/api/me/username${q({ u })}`),
      getAccountKeyBackup: () => get<{ wrapped: string | null }>("/api/me/account-key"),
      putAccountKeyBackup: (wrapped: string | null, verifier: string) => put<{ ok: true }>("/api/me/account-key", { wrapped, verifier }),
      notifications: () =>
        get<{ global: Record<string, unknown>; scopes: { scope: string; mode: "all" | "mentions" | "none"; mutedUntil: number | null; sound: string | null; vibrate: boolean }[] }>("/api/me/notifications"),
      setNotifications: (b: Record<string, unknown>) => put<{ ok: true }>("/api/me/notifications", b),
    },

    users: {
      get: (idOrAt: string) => get<PublicUser>(`/api/users/${e(idOrAt)}`),
      batch: (ids: string[]) => post<{ users: PublicUser[] }>("/api/users/batch", { ids }),
      search: (qq: string) => get<DirectorySearch>(`/api/users/search${q({ q: qq })}`),
      block: (id: string) => post<{ ok: true }>(`/api/users/${e(id)}/block`),
      unblock: (id: string) => del<{ ok: true }>(`/api/users/${e(id)}/block`),
    },

    contacts: {
      list: () => get<{ contacts: PublicUser[] }>("/api/contacts"),
      add: (userIds: string[]) => post<{ added: number }>("/api/contacts", { userIds }),
      remove: (userIds: string[]) => del<{ ok: true }>("/api/contacts", { userIds }),
      discover: (blinded: string[]) => post<{ evaluated: string[] }>("/api/contacts/discover", { blinded }),
      match: (tokens: string[]) => post<{ matches: { token: string; user: PublicUser }[] }>("/api/contacts/match", { tokens }),
    },

    devices: {
      list: () => get<{ devices: DeviceInfo[] }>("/api/devices"),
      register: (b: unknown) =>
        post<{ deviceId: string; status: "active" | "pending"; activeDevices: number; hasBackup: boolean; hasHistory: boolean }>("/api/devices", b),
      update: (b: { name?: string; pushToken?: string | null; pushPlatform?: "fcm" | "apns" | "web" | null; voipToken?: string | null }) =>
        patch<{ ok: true }>("/api/devices/current", b),
      terminate: (id: string) => del<{ ok: true }>(`/api/devices/${e(id)}`),
      activate: (b: { mode: "fresh" } | { mode: "recovery"; verifier: string }) => post<{ ok: true }>("/api/devices/current/activate", b),
      requestLink: (publicKey: string) => post<{ linkId: string; code: string; expiresAt: number }>("/api/devices/link", { publicKey }),
      pendingLinks: () =>
        get<{ requests: { linkId: string; publicKey: string; deviceName: string; platform: string; code: string; createdAt: number }[] }>("/api/devices/link"),
      linkStatus: (id: string) => get<{ status: string; ephemeralKey?: string | null; ciphertext?: string | null; publicKey?: string }>(`/api/devices/link/${e(id)}`),
      approveLink: (id: string, ephemeralKey: string, ciphertext: string) => post<{ ok: true }>(`/api/devices/link/${e(id)}`, { action: "approve", ephemeralKey, ciphertext }),
      rejectLink: (id: string) => post<{ ok: true }>(`/api/devices/link/${e(id)}`, { action: "reject" }),
    },

    keys: {
      status: () => get<{ oneTimePreKeys: number; signedPreKeyId: number | null; signedPreKeyCreatedAt: number | null }>("/api/keys"),
      upload: (b: unknown) => post<{ ok: true }>("/api/keys", b),
      bundles: (userId: string, deviceId?: string) => get<{ userId: string; bundles: PreKeyBundleWireT[] }>(`/api/keys/${e(userId)}${q({ deviceId })}`),
      certificate: () => get<{ certificate: { body: string; signature: string } }>("/api/keys/certificate"),
    },

    vault: {
      pull: (since: number, limit = 500) =>
        get<{ records: { recordId: string; kind: string; data: string | null; deleted: boolean; version: number }[]; cursor: number; more: boolean }>(`/api/vault${q({ since, limit })}`),
      push: (records: { recordId: string; kind: string; data: string | null; onlyIfAbsent?: boolean }[]) => post<{ ok: true; changed: number }>("/api/vault", { records }),
    },

    chats: {
      list: () => get<{ chats: ChatSummary[] }>("/api/chats"),
      get: (id: string) => get<ChatSummary>(`/api/chats/${e(id)}`),
      create: (b: unknown) => post<ChatSummary>("/api/chats", b),
      update: (id: string, b: unknown) => patch<ChatSummary>(`/api/chats/${e(id)}`, b),
      remove: (id: string) => del<{ ok: true }>(`/api/chats/${e(id)}`),
      members: (id: string, o: { q?: string; offset?: number; limit?: number; role?: "admins" } = {}) =>
        get<{ members: ChatMemberInfo[]; total: number }>(`/api/chats/${e(id)}/members${q(o)}`),
      addMembers: (id: string, userIds: string[]) => post<{ added: string[]; skipped: string[] }>(`/api/chats/${e(id)}/members`, { userIds }),
      setMember: (id: string, userId: string, b: { role: "admin" | "member" | "owner"; rights?: Record<string, boolean>; title?: string | null }) =>
        patch<{ ok: true }>(`/api/chats/${e(id)}/members/${e(userId)}`, b),
      removeMember: (id: string, userId: string, ban = false) => del<{ ok: true }>(`/api/chats/${e(id)}/members/${e(userId)}${ban ? "?ban=1" : ""}`),
      leave: (id: string) => post<{ ok: true }>(`/api/chats/${e(id)}/leave`),
      join: (id: string) => post<ChatSummary | { requested: true }>(`/api/chats/${e(id)}/join`),
      invites: (id: string) => get<{ invites: InviteDto[] }>(`/api/chats/${e(id)}/invites`),
      createInvite: (id: string, b: { name?: string; expiresIn?: number; usageLimit?: number; requiresApproval?: boolean }) => post<InviteDto>(`/api/chats/${e(id)}/invites`, b),
      revokeInvite: (id: string, inviteId: string) => del<{ ok: true }>(`/api/chats/${e(id)}/invites/${e(inviteId)}`),
      requests: (id: string) => get<{ requests: { userId: string; createdAt: number; user: PublicUser }[] }>(`/api/chats/${e(id)}/requests`),
      decideRequest: (id: string, userId: string, approve: boolean) => post<{ ok: true }>(`/api/chats/${e(id)}/requests/${e(userId)}`, { approve }),
      pin: (id: string, messageId: string) => post<{ pinnedIds: string[] }>(`/api/chats/${e(id)}/pins`, { messageId }),
      unpin: (id: string, messageId?: string) => del<{ pinnedIds: string[] }>(`/api/chats/${e(id)}/pins${q({ messageId })}`),
      messages: (id: string, o: { after?: number; before?: number; limit?: number }) =>
        get<{ messages: GroupMessageWire[]; lastSeq: number; more: boolean }>(`/api/chats/${e(id)}/messages${q(o)}`),
      rotateKeys: (id: string) => post<{ epoch: number }>(`/api/chats/${e(id)}/rotate`),
      views: (id: string, ids: string[]) => post<{ views: Record<string, number> }>(`/api/chats/${e(id)}/views`, { ids }),
      devices: (id: string, o: { after?: string; userIds?: string } = {}) =>
        get<{ devices: { userId: string; deviceId: string; registrationId: number }[]; next: string | null }>(`/api/chats/${e(id)}/devices${q(o)}`),
    },

    invites: {
      preview: (token: string) =>
        get<{ chatId: string; type: string; title: string; description: string | null; avatarMediaId: string | null; avatarKey: string | null; memberCount: number; requiresApproval: boolean; isMember: boolean }>(
          `/api/invites/${e(token)}`,
        ),
      join: (token: string) => post<ChatSummary | { requested: true }>(`/api/invites/${e(token)}`),
    },

    stickers: {
      list: (catalog = false) => get<{ packs: StickerPackDto[]; catalog: { id: string; name: string; title: string; installed: boolean }[] }>(`/api/stickers${catalog ? "?catalog=1" : ""}`),
      install: (packId: string) => post<{ ok: true }>(`/api/stickers/${e(packId)}`),
      uninstall: (packId: string) => del<{ ok: true }>(`/api/stickers/${e(packId)}`),
    },

    reports: { create: (b: unknown) => post<{ ok: true }>("/api/reports", b) },
    notifications: {
      list: () => get<{ notifications: { id: number; kind: string; data: Record<string, unknown>; read: boolean; createdAt: number }[] }>("/api/notifications"),
      markRead: (ids: number[]) => post<{ ok: true }>("/api/notifications", { ids }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
