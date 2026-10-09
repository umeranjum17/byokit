<h1 align="center">@byokit/link</h1>

<p align="center"><strong>Deprecated: renamed to <a href="../pair"><code>@byokit/pair</code></a>.</strong></p>

This package re-exports `@byokit/pair` as is, `@byokit/link` and `@byokit/link/node` alike, so
existing imports keep working. It is removed in 0.9.0.

## Migrate

```sh
npm uninstall @byokit/link
npm install @byokit/pair
```

Change the import specifier; the API and the Node-only `./node` entry are the same:

```ts
import { Host } from '@byokit/pair'; // was '@byokit/link'

console.log(typeof Host);
```

## License

Apache-2.0. See [LICENSE](LICENSE).
