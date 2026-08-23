# Lumen test suite

Automated tests for `index.html`, `sw.js` and `manifest.webmanifest`.
Everything runs **fully offline** — MSAL, Microsoft Graph, the thumbnail CDN
and the Microsoft login endpoint are all intercepted and answered from
fixtures. Nothing in here talks to the network.

## Running

```bash
npm install          # playwright only; the browser is already on this machine
npm test             # the whole suite, ~45s
```

Useful variations:

```bash
node tests/run.js folders scan      # only test files whose name matches
node tests/run.js --grep=429        # only tests whose name matches
node tests/run.js --jobs=1          # one file at a time (default 4) — easier debugging
LUMEN_RUN_SKIPPED=1 node tests/run.js known-bugs   # run the known-bug reproductions
LUMEN_CHROME=/path/to/chrome npm test              # different browser binary
```

The runner exits non-zero if anything fails. Chromium is expected at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; **do not** run
`playwright install`.

## Layout

```
tests/
  run.js                 the runner: discovers *.test.js, runs them, prints PASS/FAIL
  lib/
    tiny.js              test() + assert helpers (no jest/mocha)
    env.js               the shared browser + base URL for one run
    server.js            static file server for the app under test
    harness.js           launchApp(): a browser context with every route stubbed
    fixtures.js          declarative fake OneDrive tree
    drives.js            reusable drives built with the fixture DSL
    msal-stub.js         stand-in for @azure/msal-browser
    png.js               builds a real tiny PNG so thumbnails actually decode
  boot.test.js           load, boot, wiring, signed-in vs signed-out
  scan.test.js           the recursive walk: nesting, paging, pacing, 429, resume
  cache.test.js          IndexedDB cache and delta sync
  thumbs.test.js         thumbnail self-heal, cell reuse, read-only guarantee
  folders.test.js        .nomedia and the folder explorer
  local.test.js          device photos, dedupe, badges, device tree
  ui.test.js             lightbox, Back handling, menus, icons
  pwa.test.js            manifest, service worker, diagnostics
  robust.test.js         blocked IndexedDB, stalled startup, unreachable Graph
  logic.test.js          unit-level checks of the app's internal helpers
  known-bugs.test.js     reproductions of real bugs, registered as skipped
```

## How the stubbing works

`launchApp(opts)` (in `lib/harness.js`) creates a fresh browser context and
installs one catch-all `page.route("**/*")` that dispatches by origin:

| request | answered with |
| --- | --- |
| `http://127.0.0.1:<port>/…` | the real file, from `lib/server.js` |
| `https://graph.microsoft.com/**` | the Graph mock, driven by the fixture drive |
| the three MSAL CDN URLs | the MSAL stub source (should never be hit — see below) |
| `https://thumbs.example/**`, `https://dl.example/**` | a real 2×2 PNG built in `lib/png.js` |
| `https://login.microsoftonline.com/**` | a stub OpenID document (for Diagnostics) |
| anything else | aborted, so nothing can hang on DNS |

**MSAL.** `page.addInitScript()` defines `window.msal` *before* the app's
inline script runs, so `loadMsal()` short-circuits and no script tag is ever
created. The stub records every call on `window.__msal.calls`, which is how
the scope assertions work. `boot.test.js` asserts the CDN is never requested.
Options: `msal: { accounts: [] }` for signed out, `msal: { hangAt: "…" }` to
make one method never resolve, `msalLoadFails: true` to skip the stub entirely.

**Graph.** `opts.drive` is a fixture built with `buildDrive([...])`; the mock
serves `/me`, `/me/drive`, `/me/drive/root/children`,
`/me/drive/items/{id}/children` (honouring `$top` and `$skiptoken` so paging
is exercised), `/me/drive/items/{id}/thumbnails/0`, `/me/drive/items/{id}`,
and `/me/drive/root/delta`. Per-test overrides:

* `opts.graph(ctx)` — return a response spec to take over a request, or
  `null` to fall through. Specs are `{ status, json | body, headers, delay,
  abort, contentType }`; `delay` is how the "stall a later response" tests work.
* `opts.delta(token, ctx)` — answer a specific delta token.
* `opts.thumb({ url })` — answer (or 403) a thumbnail URL.
* `opts.me` — the `/me` payload.

**Other knobs:** `standalone: true` (fakes `display-mode: standalone`),
`blockIndexedDB: true`, `localStorage: { key: value }`, `initScripts: [src]`.

**Reaching into the app.** `index.html` is a classic script, so its top-level
`const`/`let` bindings live in the page's global lexical scope: tests can call
`page.evaluate(() => view.map(p => p.name))`, `setFolderVisible(...)`,
`refreshTimeline(true)` and so on directly. The `App` object wraps the common
ones (`viewNames()`, `folderRows()`, `hiddenPaths()`, `waitForScan()`, …).

**Service worker.** Contexts are created with `serviceWorkers: "block"` so
registration cannot interfere with routing. `sw.js` is tested separately by
evaluating it in a Node `vm` sandbox with mock `caches`/`fetch`/`self`
(`pwa.test.js`), which is the only reliable way to reproduce "the network
failed *and* nothing is cached".

## Adding a test

```js
const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");

test("what it should do", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();          // navigate + wait for the splash to clear
    await app.waitForScan();   // wait for the scan to settle
    assert.eq(await app.cellCount(), 5);
  } finally { await app.close(); }
}, { timeout: 40000 });        // optional; 30s default
```

Rules of thumb:

* Always `await app.close()` in a `finally` — contexts are not reaped for you.
* After triggering a rescan, `await app.waitForScanStart()` (or `app.rescan()`)
  before `waitForScan()`, otherwise you may match the *previous* run's
  "Scan complete".
* Assert `app.pageErrors` is empty in tests that exercise an error path.
* Keep drives small. Graph requests are paced ~180 ms apart by the app itself,
  so every extra folder costs real time.
* Test files run in parallel (4 at a time); tests inside a file run in order.

## Known bugs (reproduced, not fixed)

`known-bugs.test.js` holds three reproductions, registered with `test.skip` so
the suite stays green. Each was confirmed to fail against `index.html`.
Delete the `.skip` once the app is fixed and they become regression tests.

1. **`.nomedia` off + rescan does nothing.** The first scan honours the marker,
   so the folder holds no photos, so `autoHideEmptyFolders()` (index.html:1622)
   unticks it and records it in `autoHidden`. Nothing ever removes it, so after
   the user turns the switch off and follows the app's own toast
   ("Rescan to load photos from those folders", index.html:1660), the photos are
   fetched into `photos` but `buildView()` still filters them out.
2. **Folders discovered by delta never join the tree.** `deltaSync()`
   (index.html:788) adds photos but never appends to `folderTree`, so
   `buildFolderIndex()` has no node for the new path: the photos are missing
   from every folder count and there is no row to untick.
3. **The empty state is destroyed by the first scan failure.**
   `$("empty").innerHTML = "<h2>Couldn't load photos</h2>…"` (index.html:1279)
   replaces the markup permanently, so a later successful scan of a genuinely
   empty drive repeats the old error instead of "No photos found".

Smaller notes, recorded in tests rather than reported as bugs:

* `monthLabel(null)` is "January 1970", not "Undated" (`new Date(null)` is the
  epoch). Harmless today because Graph always sends `lastModifiedDateTime`.
  Asserted as current behaviour in `logic.test.js` (L3).
* With IndexedDB blocked, the gallery takes ~8–12 s to appear: `idb()` times
  out after 4 s (index.html:508) and `startGallery()` opens it serially two or
  three times. Under the 15 s boot watchdog, but not by much. Covered by
  `robust.test.js` (42).
* Diagnostics probes Graph with `method: "HEAD"` (index.html:1743). HEAD is
  read-only, but it is the one non-GET request the app makes to Graph, so the
  read-only assertion in `thumbs.test.js` (18) covers a full scan plus the
  lightbox, not the Diagnostics panel.
