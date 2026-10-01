# @byokit/browser

Take a PNG screenshot of a URL, HTML string, or explicitly named local HTML file.
The app selects an installed Chromium or Chrome. The kit never downloads a browser,
attaches to a running browser, or opens a person's existing browser profile.

Node 22.18+ only, including an Electron main process. No PWA, browser, React Native,
Firefox, or WebKit entry. No account, subscription, API key, model call, or per-use bill
is involved. Screenshot bytes stay on the device unless the app sends them elsewhere.

```sh
npm install @byokit/browser
```

```ts
import { writeFile } from 'node:fs/promises';
import { createBrowser, findChromium } from '@byokit/browser';

// The host owns browser installation and this candidate list. No HOME or PATH scan.
const executablePath = await findChromium(['/usr/bin/chromium', '/usr/bin/google-chrome']);
if (!executablePath) throw new Error('Install a browser to take screenshots.');

const session = await createBrowser({
  executablePath,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  timeoutMs: 20_000,
  allowUrl: url => url.origin === 'http://127.0.0.1:3000',
});
try {
  await session.open({ url: 'http://127.0.0.1:3000/' });
  await session.waitFor({ selector: 'html[data-rendered="1"]' });
  await session.waitFor({ fonts: true });
  await writeFile('page.png', await session.screenshot({ fullPage: true }));

  await session.setViewport({ width: 390, height: 844 });
  await session.open({ html: '<main id="screen">Hello</main>' });
  await session.waitFor({ expression: 'document.querySelector("#screen") !== null' });
  await writeFile('screen.png', await session.screenshot({ selector: '#screen' }));
} finally {
  await session.close();
}
```

`open({ file: '/absolute/path/page.html' })` reads only that app-named file. HTML is
loaded on a fresh blank document, so it cannot inherit the previous URL's origin or
relative asset base. Inline assets or an explicit HTTP(S) `<base>` work; relative
filesystem assets do not. `open({ url })` accepts absolute HTTP(S) URLs only.
The app owns URL normalization and supplies local file paths deliberately.

Each session owns one page and a private temporary profile. Operations are serialized
in call order; use separate sessions for concurrent documents. `close()` waits for
queued work, closes the browser, and removes its profile, including on a close error.
Close is idempotent; later operations reject. Startup failure removes the profile.
Always close in `finally`; forced process termination can leave temporary directories
for the host's normal temp cleanup. Cookies and page storage last only for this session.

| Setting or operation | Behavior |
| --- | --- |
| `executablePath` | Required absolute path; checked for an executable file, never inferred |
| `findChromium(candidates)` | First executable in the explicit absolute-path list, or `undefined`; does not verify the binary's identity |
| `viewport` / `setViewport` | Positive integer CSS-pixel width and height; default 1280 × 800 |
| `deviceScaleFactor` | Positive finite scale at session creation; default 1; start another session to change it |
| `timeoutMs` | Positive finite deadline per browser operation; default 20 seconds |
| `open(source, { waitUntil })` | Defaults to `domcontentloaded`; also accepts `load` and `networkidle` |
| `waitFor({ selector, state })` | Defaults to visible; also attached, hidden, detached |
| `waitFor({ expression })` | Browser-side JavaScript expression, polled until truthy; closures cannot be captured |
| `waitFor({ fonts: true })` | Waits for the document's font loading promise |
| `screenshot()` | Viewport PNG bytes; `{ fullPage: true }` captures the page; `{ selector }` captures one visible element |
| `reducedMotion` | Defaults to `reduce`; captures also disable animations |
| `sandbox` | Chromium sandbox enabled by default; explicit `false` for an app-owned sandbox/container only |
| `env` | Child environment built from nothing plus app values; HOME, profile-related folders and temp paths remain kit-owned |
| `allowUrl` | Optional host authorization callback for explicit URL opens |

Readiness belongs to the app: `domcontentloaded` does not mean an application has
finished rendering. Prefer its ready selector/expression and font wait. `networkidle`
may time out on pages with continuous traffic. Missing or ambiguous elements and
timeouts reject with `BrowserError` and a plain message. Errors have a stable `code`
and intentionally omit raw browser errors, HTML, URLs, environment values and secrets.
The kit adds no console, request, or credential logging.

`allowUrl` authorizes only the target passed to `open`. It is **not a network firewall**:
redirects, subresources, in-page navigation and HTML scripts can reach the network.
The app must authorize content and use an OS/container network policy when capturing
untrusted pages (including local/private-address restrictions). A private profile
does not isolate the browser from all host files. No sign-in import, saved-profile
option, arbitrary launch flags, remote browser connection, or token forwarding is
exposed. Pass only the environment values the browser needs; no host environment or
API keys are inherited by its child process. Service workers and downloads are disabled.

The runtime dependency is exactly pinned `playwright-core`, which installs no browser.
Installed browser compatibility depends on that driver; see the
[upstream executable-path limits](https://playwright.dev/docs/api/class-browsertype#browser-type-launch).
Desktop Linux, macOS and Windows paths may be supplied, but the host must qualify its
installed browser and sandbox. Screenshots depend on installed fonts and browser versions.
PNG encoding is the only output format; caches, render queues spanning sessions, JPEG
conversion, image uploads, and application grading belong to the host.

For offline tests, pass a fake launcher as `createBrowser`'s second argument:

```ts
import { createBrowser } from '@byokit/browser';
import { fakeBrowser } from '@byokit/browser/testing';

const fake = fakeBrowser(new Uint8Array([137, 80, 78, 71]));
// A checked executable stand-in: it will never be spawned by the fake.
const session = await createBrowser({ executablePath: process.execPath }, fake.launch);
try {
  await session.open({ html: '<main>Hello</main>' });
  const bytes = await session.screenshot();
  console.log(bytes.length, fake.calls.length);
} finally {
  await session.close();
}
```

`fakeBrowser` records calls and launch settings in memory and returns the bytes you
provide. It does not render or validate PNGs. The `BrowserLauncher` seam can also
simulate failures and pending operations without a browser, account, or network.
