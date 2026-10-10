// VENDIA — service worker : reçoit les alertes push (client à traiter) même app fermée.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'VENDIA', body: event.data ? event.data.text() : '' }; }
  const urgent = !!d.urgent;
  event.waitUntil((async () => {
    // Si l'application est ouverte et visible, elle joue elle-même le bip : on prévient la page.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(w => w.postMessage({ type: 'vendia-push', payload: d }));
    await self.registration.showNotification(d.title || 'VENDIA', {
      body: d.body || '',
      icon: '/assets/icon-192.png',
      badge: '/assets/favicon-32.png',
      tag: d.tag || 'vendia',
      renotify: true,
      requireInteraction: urgent,
      vibrate: urgent ? [400, 150, 400, 150, 400, 150, 800] : [200],
      data: { url: d.url || '/' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) { await w.focus(); w.postMessage({ type: 'vendia-open', url }); return; }
    }
    await self.clients.openWindow(url);
  })());
});
