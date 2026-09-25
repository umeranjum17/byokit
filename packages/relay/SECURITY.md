# Security boundaries

The relay routes `@byokit/link` device frames as ciphertext and does not authenticate devices; the host authenticates them during the link handshake. The relay does see host addresses, connection metadata, push subscriptions and notification actions.

Push notification text is the exception to the no-plaintext link boundary. The relay reads the notification title and any body or data the host explicitly includes. `RelayClient.notify` omits body and data by default; `{ includeContent: true }` forwards them. Use generic titles and fetch private details over the link. Expo and its delivery providers can read Expo notification text. Web Push payloads are encrypted for the browser by the relay, so the relay reads them before encryption even though the push service cannot decrypt them.

Web Push endpoints are restricted to the configured subset of known HTTPS push-service hosts. Redirects are not followed. Keep the relay's store private: it contains host registrations, enrolment claim hashes, push subscriptions and VAPID keys.

## Known limit / follow-up

If `revoke(device)` runs while the relay is offline and the client stops before reconnecting, its queued unsubscribe is lost. The link grant has been removed, but the relay may still hold the device's push subscriptions and action tokens. A future change should reconcile relay subscriptions against the host's current device list on reconnect; this release does not do so.
