// Vercel serverless function (Node.js runtime, Hobby/free tier).
//
// Receives a POST from index.html the instant a route deviation alert
// fires. Reads the observer's stored Web Push subscription from Firebase
// Realtime Database (via the Admin SDK - a service-account-authenticated
// read/write that bypasses RTDB security rules, and does NOT require the
// Blaze plan), then sends a real Web Push notification signed with VAPID.
//
// SECURITY: the PIN is used here only to build the correct RTDB path
// server-side. It is NEVER included in the push payload sent to the
// browser/OS (see the `payload` object below) - only the Trip ID is.
//
// Required Vercel project environment variables:
//   FIREBASE_SERVICE_ACCOUNT_JSON  - the full service account JSON, as one string
//   FIREBASE_DATABASE_URL          - e.g. https://intelligent-route-monitor-default-rtdb.asia-southeast1.firebasedatabase.app
//   VAPID_PUBLIC_KEY               - from `npx web-push generate-vapid-keys`
//   VAPID_PRIVATE_KEY              - from the same command; keep secret
//   VAPID_CONTACT_EMAIL            - e.g. mailto:you@example.com (required by the Web Push spec)
//
// Required dependencies (see package.json alongside this file):
//   firebase-admin, web-push

const admin = require('firebase-admin');
const webpush = require('web-push');

let firebaseApp;
function getFirebaseApp() {
  if (!firebaseApp) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
  return firebaseApp;
}

webpush.setVapidDetails(
  process.env.VAPID_CONTACT_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const {
    tripId,
    pin,
    severity,
    alertCount,
    distanceFromRoute,
    destinationDistance,
    lat,
    lon,
    // TEMPORARY DIAGNOSTIC fields (test button in observer.html). Not
    // used by the real deviation-alert flow, which never sends these.
    isTest,
    title,
    body
  } = req.body || {};

  if (!tripId || !pin) {
    res.status(400).json({ error: 'tripId and pin are required' });
    return;
  }

  try {
    const db = getFirebaseApp().database();
    const snapshot = await db
      .ref('trips/' + tripId + '/' + pin + '/pushSubscription')
      .once('value');
    const subscription = snapshot.val();

    if (!subscription) {
      // No observer has enabled notifications for this trip yet -
      // nothing to send. Not an error condition.
      res.status(200).json({ sent: false, reason: 'no-subscription' });
      return;
    }

    // Deliberately omits `pin` - only the Trip ID travels in the push
    // payload, matching the requirement that the PIN never appears in
    // the notification payload, text, or any URL. This holds for both
    // branches below.
    //
    // TEMPORARY DIAGNOSTIC: when isTest is true (only ever sent by the
    // test button in observer.html), send a fixed test payload instead
    // of real deviation data. This is purely an additive branch - the
    // real deviation payload shape below is unchanged.
    const payload = isTest
      ? JSON.stringify({
          isTest: true,
          tripId: tripId,
          title: title || 'Test Push Notification',
          body: body || 'Web Push is working!'
        })
      : JSON.stringify({
          tripId: tripId,
          severity: severity,
          alertCount: alertCount,
          distanceFromRoute: distanceFromRoute,
          destinationDistance: destinationDistance,
          lat: lat,
          lon: lon
        });

    await webpush.sendNotification(subscription, payload);
    res.status(200).json({ sent: true });
  } catch (err) {
    console.error('notify-observer error:', err);

    // A common real-world case: the subscription expired or was revoked
    // by the browser. Clean it up so future alerts don't keep failing
    // against a dead endpoint.
    if (err.statusCode === 404 || err.statusCode === 410) {
      try {
        const db = getFirebaseApp().database();
        await db.ref('trips/' + tripId + '/' + pin + '/pushSubscription').remove();
      } catch (cleanupErr) {
        console.warn('Could not clean up expired subscription:', cleanupErr.message);
      }
      res.status(200).json({ sent: false, reason: 'subscription-expired' });
      return;
    }

    res.status(500).json({ error: err.message });
  }
};
