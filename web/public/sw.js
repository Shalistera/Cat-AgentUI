// Service worker — notifications only.
//
// There is deliberately NO fetch handler: with none registered the browser
// sends every request (the SSE reply streams included) straight to the
// network, exactly as if no worker existed. The worker exists because
// Android Chrome refuses `new Notification()` from a page — notifications
// there must come from a registration — and because a clicked notification
// should still land somewhere after its tab was closed.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // A tab already on that page wins; otherwise reuse one of ours and let
    // the app route it (no reload); only with none left open a window.
    const exact = wins.find((c) => c.url === url);
    const target = exact || wins.find((c) => c.focused) || wins[0];
    if (!target) {
      await self.clients.openWindow(url);
      return;
    }
    try { await target.focus(); } catch { /* the browser may refuse; still route it */ }
    if (!exact) target.postMessage({ type: 'cat-navigate', url });
  })());
});
