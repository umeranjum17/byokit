<h1 align="center">@byokit/ui-core</h1>

<p align="center"><strong>Deprecated: renamed to <a href="../ui"><code>@byokit/ui</code></a>.</strong></p>

This package re-exports `@byokit/ui` unchanged, every entry alike, so
existing imports keep working through 0.7.x. It is removed in 0.8.0.

## Migrate

```sh
npm uninstall @byokit/ui-core
npm install @byokit/ui
```

Change the import specifier; the API and every entry (`/phase`, `/route`,
`/link`, `/kits`, `/steps`, `/connect`) are the same:

```ts
import { phaseOf } from '@byokit/ui'; // was '@byokit/ui-core'

console.log(typeof phaseOf);
```
