self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Si el chat está abierto y a la vista, no hace falta avisar
    if (!data.test && wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(data.title || '💬 Chat de amigos', {
      body: data.body || '',
      tag: data.tag || 'chat-amigos',
      renotify: true,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return clients.openWindow('/');
  })());
});
