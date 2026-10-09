<h1 align="center">@byokit/overlay</h1>

<p align="center"><strong>Deprecated: renamed to <a href="../bubble"><code>@byokit/bubble</code></a>.</strong></p>

This package re-exports `@byokit/bubble` unchanged, `@byokit/overlay`, `@byokit/overlay/focused-field` and
`@byokit/overlay/screen-frame` alike, so
existing imports keep working through 0.3.x. It is removed in 0.4.0.

## Migrate

```sh
npm uninstall @byokit/overlay
npm install @byokit/bubble
```

Change the import specifier; the API and the `./focused-field` and `./screen-frame` entries are the same:

```ts
import { overlay } from '@byokit/bubble'; // was '@byokit/overlay'

console.log(typeof overlay);
```

## License

Apache-2.0. See [LICENSE](LICENSE).
