"use client";
import { create } from "zustand";
import type { StoredMessage } from "../lib/types";

export type Tab = "chats" | "contacts" | "calls" | "settings";
export type Panel = { kind: "user"; userId: string } | { kind: "chat"; chatId: string } | null;

interface UIState {
  tab: Tab;
  activeChatId: string | null;
  panel: Panel;
  showArchived: boolean;
  settingsPage: string | null;
  replyTo: Record<string, StoredMessage | null>;
  editing: Record<string, StoredMessage | null>;
  selection: Set<string>;
  jump: { chatId: string; messageId: string; nonce: number } | null;
  viewer: { items: StoredMessage[]; index: number } | null;
  forwarding: StoredMessage[] | null;
  chatSearchOpen: boolean;
  globalSearch: boolean;
  newChat: "menu" | "group" | "channel" | null;
  searchHighlight: string;
  reporting: { chatId: string; messages: StoredMessage[] } | null;
  setTab: (t: Tab) => void;
  openChat: (id: string | null) => void;
  setPanel: (p: Panel) => void;
  setReply: (chatId: string, m: StoredMessage | null) => void;
  setEditing: (chatId: string, m: StoredMessage | null) => void;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
  jumpTo: (chatId: string, messageId: string) => void;
  set: (p: Partial<UIState>) => void;
}

export const useUI = create<UIState>((set) => ({
  tab: "chats",
  activeChatId: null,
  panel: null,
  showArchived: false,
  settingsPage: null,
  replyTo: {},
  editing: {},
  selection: new Set(),
  jump: null,
  viewer: null,
  forwarding: null,
  chatSearchOpen: false,
  globalSearch: false,
  newChat: null,
  searchHighlight: "",
  reporting: null,
  setTab: (tab) => set({ tab }),
  openChat: (activeChatId) => set({ activeChatId, selection: new Set(), chatSearchOpen: false, panel: null }),
  setPanel: (panel) => set({ panel }),
  setReply: (chatId, m) => set((s) => ({ replyTo: { ...s.replyTo, [chatId]: m }, editing: { ...s.editing, [chatId]: null } })),
  setEditing: (chatId, m) => set((s) => ({ editing: { ...s.editing, [chatId]: m }, replyTo: { ...s.replyTo, [chatId]: null } })),
  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selection: next };
    }),
  clearSelection: () => set({ selection: new Set() }),
  jumpTo: (chatId, messageId) => set({ activeChatId: chatId, jump: { chatId, messageId, nonce: Date.now() } }),
  set: (p) => set(p),
}));
