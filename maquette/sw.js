// Service worker Frescy : affiche les notifications système et ouvre l'app au toucher.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Pièce 2 : les alertes quotidiennes envoyées par le serveur arriveront ici.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Frescy', {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: 'frescy-alerte',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) if ('focus' in client) return client.focus();
    return self.clients.openWindow(url);
  }));
});
