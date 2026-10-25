type Handler<T> = (payload: T) => void;

export interface EngineEvents {
  "messages:changed": { chatId: string; ids: string[]; removed?: string[] };
  "chats:changed": { ids: string[] };
  "account:changed": void;
  typing: { chatId: string; userId: string; action: string };
  presence: { userId: string; online: boolean; lastSeenAt: number | null; approx?: string };
  connection: { state: "connecting" | "online" | "offline" | "syncing" };
  "identity:changed": { userId: string };
  "device:revoked": void;
  "link:request": { linkId: string; deviceName: string; platform: string };
  "call:event": { type: string; data: unknown };
  "upload:progress": { messageId: string; progress: number };
  notify: { chatId: string; title: string; body: string; messageId: string };
  "screenshot": { chatId: string; userId: string };
}

class Bus {
  private handlers = new Map<string, Set<Handler<unknown>>>();
  on<K extends keyof EngineEvents>(event: K, fn: Handler<EngineEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as Handler<unknown>);
    return () => set!.delete(fn as Handler<unknown>);
  }
  emit<K extends keyof EngineEvents>(event: K, payload: EngineEvents[K]) {
    for (const fn of this.handlers.get(event) ?? []) {
      try {
        fn(payload);
      } catch (e) {
        console.error("[bus]", event, e);
      }
    }
  }
}

export const bus = new Bus();
