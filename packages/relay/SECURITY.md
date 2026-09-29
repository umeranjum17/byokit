# Security boundaries

The relay routes `@byokit/link` device frames as ciphertext and does not authenticate link devices; the host authenticates them during the link handshake. The relay does see host addresses, connection metadata, push subscriptions, device grant IDs used for push, and notification actions.

Push notification text is the exception to the no-plaintext link boundary. The relay reads the notification title and any body or data the host explicitly includes. `RelayClient.notify` omits body and data by default; `{ includeContent: true }` forwards them. Use generic titles and fetch private details over the link. Expo and its delivery providers can read Expo notification text. Web Push payloads are encrypted for the browser by the relay, so the relay reads them before encryption even though the push service cannot decrypt them.

Web Push endpoints are restricted to the configured subset of known HTTPS push-service hosts. Redirects are not followed. Keep the relay's store private: it contains host registrations, enrolment claim hashes, push subscriptions and VAPID keys.

## Device revoke

`RelayClient.revoke(device)` saves the device to the client's `store` before removing its link grant, and resends the unsubscribe on every connection until the relay confirms that the device's push subscriptions and action tokens are gone (or the relay no longer has the host at all). A relay that is down, restarting or behind a full offline queue delays the removal but no longer loses it. The default store is memory: without a durable one, a host that restarts before the relay confirms forgets the pending unsubscribe, and the relay may keep notifying the removed device.
