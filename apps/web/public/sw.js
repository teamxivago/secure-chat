/* Veil service worker: Web Push for the desktop PWA. Payloads never contain message content. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* ignore */
  }
  if (!data.title) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Skip if a focused window is open: the app shows its own in-app notification.
      if (clients.some((c) => c.focused)) return;
      return self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: data.data || {},
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chatId = event.notification.data && event.notification.data.chatId;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients[0];
      if (existing) {
        existing.focus();
        if (chatId) existing.postMessage({ type: "open-chat", chatId });
        return;
      }
      return self.clients.openWindow("/");
    }),
  );
});
