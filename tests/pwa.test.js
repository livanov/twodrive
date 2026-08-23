"use strict";
/* Manifest, service worker and the diagnostics panel.
   The service worker's fetch handler is exercised directly in Node against a
   mock cache/network — that is the only way to make "the network failed AND
   nothing is cached" reproducible. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "manifest.webmanifest");
const SW = path.join(ROOT, "sw.js");

/* Read width/height straight out of a PNG's IHDR chunk. */
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.eq(b.slice(1, 4).toString("ascii"), "PNG", `${path.basename(file)} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test("39 · manifest.webmanifest is valid and its icons exist at the sizes it claims", () => {
  const raw = fs.readFileSync(MANIFEST, "utf8");
  let m;
  try { m = JSON.parse(raw); } catch (e) { assert.fail("manifest is not valid JSON: " + e.message); }

  assert.ok(m.name, "manifest has no name");
  assert.ok(m.short_name, "manifest has no short_name");
  assert.ok(m.start_url, "manifest has no start_url");
  assert.eq(m.display, "standalone", "display must be standalone for an installed PWA");
  assert.ok(Array.isArray(m.icons) && m.icons.length, "manifest has no icons");
  assert.match(m.theme_color || "", /^#[0-9a-f]{3,8}$/i, "theme_color");
  assert.match(m.background_color || "", /^#[0-9a-f]{3,8}$/i, "background_color");

  for (const want of ["192x192", "512x512"]) {
    const icon = m.icons.find((i) => i.sizes === want);
    assert.ok(icon, `no ${want} icon declared`);
    const file = path.join(ROOT, icon.src);
    assert.ok(fs.existsSync(file), `${icon.src} is declared but missing on disk`);
    const [w, h] = want.split("x").map(Number);
    const got = pngSize(file);
    assert.eq(`${got.w}x${got.h}`, `${w}x${h}`, `${icon.src} is the wrong size`);
    assert.eq(icon.type, "image/png");
  }

  /* The document must actually link the manifest and an icon. */
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /<link[^>]+rel="manifest"[^>]+href="manifest\.webmanifest"/);
  assert.match(html, /<meta[^>]+name="theme-color"/);
});

/* ---- service worker under test, in a sandbox ---- */
function loadSw() {
  const listeners = {};
  const store = new Map();          // cacheName -> Map(url -> Response)
  const netLog = [];
  const ctl = {
    fail: false,                    // make fetch() reject
    listeners, store, netLog,
    skipWaitingCalls: 0, claimCalls: 0,
  };

  const cacheFor = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };
  const cacheObj = (name) => ({
    async addAll(urls) { for (const u of urls) cacheFor(name).set(u, new Response("shell:" + u)); },
    async put(req, res) { cacheFor(name).set(typeof req === "string" ? req : req.url, res); },
    async match(req) { return cacheFor(name).get(typeof req === "string" ? req : req.url) || undefined; },
  });

  const sandbox = {
    self: {
      location: { origin: "https://lumen.test" },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => { ctl.skipWaitingCalls++; },
      clients: { claim: async () => { ctl.claimCalls++; } },
    },
    caches: {
      open: async (name) => cacheObj(name),
      keys: async () => [...store.keys()],
      delete: async (name) => store.delete(name),
      match: async (req) => {
        const url = typeof req === "string" ? req : req.url;
        for (const m of store.values()) if (m.has(url)) return m.get(url);
        return undefined;
      },
    },
    fetch: async (req) => {
      netLog.push(typeof req === "string" ? req : req.url);
      if (ctl.fail) throw new TypeError("Failed to fetch");
      return new Response("from network", { status: 200 });
    },
    Response, Request, URL, Promise, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW, "utf8"), sandbox, { filename: "sw.js" });

  ctl.dispatchFetch = (request) => {
    let responded;
    const event = {
      request,
      respondWith(p) { responded = p; },
      waitUntil() {},
    };
    listeners.fetch(event);
    return responded;   // undefined means "not handled — browser default"
  };
  ctl.dispatchLifecycle = async (type) => {
    let held;
    listeners[type]({ waitUntil(p) { held = p; } });
    await held;
  };
  return ctl;
}

const req = (url, opts = {}) => ({ url, method: opts.method || "GET", mode: opts.mode || "cors" });

test("40 · sw.js: a failed network with nothing cached still yields a real Response (503)", async () => {
  const sw = loadSw();
  await sw.dispatchLifecycle("install");
  sw.store.clear();                    // nothing cached at all
  sw.fail = true;

  const p = sw.dispatchFetch(req("https://lumen.test/never-seen.json"));
  assert.ok(p, "respondWith() was never called for a same-origin GET");
  const res = await p;
  assert.ok(res instanceof Response, "respondWith resolved with something that is not a Response");
  assert.eq(res.status, 503, "offline-and-uncached must be a 503, never undefined");
  assert.eq(await res.text(), "Offline and not cached");
});

test("40b · sw.js: an offline navigation falls back to the cached shell", async () => {
  const sw = loadSw();
  await sw.dispatchLifecycle("install");
  assert.gte(sw.store.size, 1, "install did not populate a cache");
  sw.fail = true;

  const res = await sw.dispatchFetch(req("https://lumen.test/deep/link", { mode: "navigate" }));
  assert.ok(res instanceof Response);
  assert.eq(res.status, 200, "a navigation offline should serve the cached index.html");
  assert.match(await res.text(), /index\.html/);
});

test("40c · sw.js: online responses are served and cached; offline hits come from the cache", async () => {
  const sw = loadSw();
  await sw.dispatchLifecycle("install");

  const first = await sw.dispatchFetch(req("https://lumen.test/index.html"));
  assert.eq(first.status, 200);
  assert.eq(await first.text(), "from network", "network-first was not honoured");
  await new Promise((r) => setImmediate(r));   // the cache write is fire-and-forget

  sw.fail = true;
  const offline = await sw.dispatchFetch(req("https://lumen.test/index.html"));
  assert.ok(offline instanceof Response);
  assert.eq(await offline.text(), "from network", "the cached copy was not returned offline");
});

test("40d · sw.js: non-GET and cross-origin requests are left alone", async () => {
  const sw = loadSw();
  await sw.dispatchLifecycle("install");
  assert.eq(sw.dispatchFetch(req("https://lumen.test/x", { method: "POST" })), undefined,
    "the worker must not intercept non-GET requests");
  assert.eq(sw.dispatchFetch(req("https://graph.microsoft.com/v1.0/me")), undefined,
    "the worker must not intercept Graph traffic");
  assert.eq(sw.dispatchFetch(req("https://thumbs.example/t/a.png")), undefined,
    "the worker must not intercept thumbnail traffic");
  const before = sw.netLog.length;
  sw.dispatchFetch(req("https://graph.microsoft.com/v1.0/me"));
  assert.eq(sw.netLog.length, before, "the worker re-issued a cross-origin request");
});

test("40e · sw.js: activate drops stale cache buckets and claims clients", async () => {
  const sw = loadSw();
  await sw.dispatchLifecycle("install");
  sw.store.set("lumen-shell-v1", new Map());       // a leftover from an old version
  await sw.dispatchLifecycle("activate");
  assert.deepEq([...sw.store.keys()], ["lumen-shell-v2"], "stale caches were not cleaned up");
  assert.eq(sw.claimCalls, 1, "clients.claim() was not called");
});

test("41 · the diagnostics panel opens and reports every section", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();

    await app.page.click("#menuBtn");
    await app.page.click("#menuDiag");
    await app.page.waitForSelector("#diag.open");
    await app.page.waitForFunction(() =>
      /Recent log/.test(document.getElementById("diagOut").textContent),
      undefined, { timeout: 20000, polling: 100 });

    const out = await app.page.textContent("#diagOut");
    for (const section of ["LUMEN DIAGNOSTICS", "— Environment —", "— Service worker & caches —",
      "— Network reachability —", "— Auth —", "— Graph calls —", "— Local data —", "— Recent log"]) {
      assert.includes(out, section, "missing diagnostics section");
    }
    assert.match(out, /msal library: loaded/);
    assert.match(out, /accounts:\s+1/);
    assert.match(out, /silent token: ok/);
    assert.match(out, /photos in memory: 5 onedrive/);
    assert.match(out, /deltaLink: present/);
    assert.match(out, /full scan finished: (?!NEVER)/);
    assert.match(out, /\/me: 200/);
    assert.match(out, /indexeddb cache: 5 photos/);

    await app.page.click("#diagClose");
    assert.eq(await app.page.evaluate(() =>
      document.getElementById("diag").classList.contains("open")), false);
  } finally { await app.close(); }
}, { timeout: 60000 });
