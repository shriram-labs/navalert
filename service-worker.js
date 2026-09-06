// Service worker for the observer's Web Push notifications.
//
// Handles exactly two events:
//   1. 'push'             - a Vercel function sent a push message when a
//                            route deviation alert fired; show a native
//                            OS notification, even if observer.html is
//                            closed.
//   2. 'notificationclick' - the observer tapped the notification; open
//                            (or focus) observer.html for the exact trip.
//
// SECURITY: the PIN never appears here. The push payload built by the
// Vercel function (api/notify-observer.js) intentionally omits it, and
// the click handler below only ever opens a URL containing the Trip ID.
// The PIN is resolved locally, client-side, from localStorage inside
// observer.html (or the observer re-enters it manually) - it never
// travels through the push network, the notification itself, or any
// URL.

self.addEventListener('push', function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = {};
  }

  // TEMPORARY DIAGNOSTIC: test pushes (sent only by the test button in
  // observer.html, via notify-observer.js's isTest branch) carry a
  // fixed title/body and skip the severity/distance formatting below
  // entirely. Uses its own notification tag ('test-push') so it never
  // collides with or replaces a real trip alert in the tray. Safe to
  // delete this whole block once push delivery is confirmed working.
  if (data.isTest) {
    const testOptions = {
      body: data.body || 'Web Push is working!',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: 'test-push',
      renotify: true,
      data: {
        tripId: data.tripId // Trip ID only - the PIN is never included here.
      }
    };
    event.waitUntil(self.registration.showNotification(data.title || 'Test Push Notification', testOptions));
    return;
  }

  const severityRaw = data.severity || 'route';
  const severityLabel = severityRaw.charAt(0).toUpperCase() + severityRaw.slice(1);
  const alertCount = data.alertCount || 1;
  const title = severityLabel + ' Route Deviation - Alert #' + alertCount;

  const bodyLines = [];
  if (typeof data.distanceFromRoute === 'number') {
    bodyLines.push('Off route by ' + Math.round(data.distanceFromRoute) + ' m');
  }
  if (typeof data.destinationDistance === 'number') {
    bodyLines.push(Math.round(data.destinationDistance) + ' m to destination');
  }
  const body = bodyLines.length > 0 ? bodyLines.join(' | ') : 'Tap to view the live trip.';

  const options = {
    body: body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // Same tag re-used per trip so a newer alert replaces an older one
    // in the notification tray instead of stacking duplicates.
    tag: 'trip-' + data.tripId,
    renotify: true,
    data: {
      tripId: data.tripId // Trip ID only - the PIN is never included here.
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  const tripId = event.notification.data && event.notification.data.tripId;
  const url = tripId
    ? ('observer.html?trip=' + encodeURIComponent(tripId))
    : 'observer.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      // If an observer.html tab is already open, navigate and focus it
      // instead of opening a duplicate tab.
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.indexOf('observer.html') !== -1 && 'focus' in client) {
          if ('navigate' in client) {
            client.navigate(url);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
