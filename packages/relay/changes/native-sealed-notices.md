- Add `mutableContent`, `categoryId` and `dataOnly` to `Notification`, passed to Expo: iOS alerts can be rewritten by
  the app's Notification Service Extension and show the app's category, and Android tokens get a data-only message
  with no visible title, body or sound. Expo subscriptions take an optional `platform` (`'ios'` or `'android'`);
  only Android tokens get data-only messages, so older subscriptions keep the visible alert.
