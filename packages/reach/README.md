<h1 align="center">@byokit/reach</h1>

<p align="center"><strong>Deprecated: renamed to <a href="../discover"><code>@byokit/discover</code></a>.</strong></p>

This package re-exports `@byokit/discover` unchanged, `@byokit/reach` and `@byokit/reach/react-native` alike, so
existing imports keep working through 0.7.x. It is removed in 0.8.0.

## Migrate

```sh
npm uninstall @byokit/reach
npm install @byokit/discover
```

Change the import specifier; the API, the `react-native` export condition and the native module are the same:

```ts
import { routes } from '@byokit/discover'; // was '@byokit/reach'

console.log(routes().lan);
```

## License

Apache-2.0. See [LICENSE](LICENSE).
