"use strict";
/* The test harness: one browser context per test, with every external
   dependency (MSAL CDN, Microsoft Graph, thumbnail CDN, Microsoft login)
   intercepted by page.route() and answered from fixtures.
   Nothing in the suite touches the network. */

const { PNG } = require("./png");
const { msalStubSource } = require("./msal-stub");
const env = require("./env");

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH = GRAPH_ORIGIN + "/v1.0";
const DELTA_BASE = GRAPH + "/me/drive/root/delta";
const CDN_RE = /(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com).*msal-browser/;

const DEFAULT_ME = {
  id: "user-1",
  displayName: "Test Person",
  mail: "tester@example.com",
  userPrincipalName: "tester@example.com",
};

/* ------------------------------------------------------------------ */
/* Init scripts injected before the app's inline script runs           */
/* ------------------------------------------------------------------ */

/* Records whether the connect/setup screen was EVER painted, so a test can
   prove it did not flash on the way to the gallery. */
const SCREEN_TRACKER = `(() => {
  window.__screens = { setupEverShown: false, galleryEverShown: false, frames: 0 };
  const tick = () => {
    window.__screens.frames++;
    const s = document.getElementById("setup");
    const g = document.getElementById("gallery");
    if (s && getComputedStyle(s).display !== "none") window.__screens.setupEverShown = true;
    if (g && getComputedStyle(g).display !== "none") window.__screens.galleryEverShown = true;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const STANDALONE = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => /display-mode:\\s*standalone/.test(q)
    ? { matches: true, media: q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, onchange: null }
    : real(q);
})();`;

/* IndexedDB that opens but never fires an event — the "blocked/unavailable"
   case the app is supposed to survive. */
const IDB_HANG = `(() => {
  const openReq = () => ({ onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, result: null, error: null });
  indexedDB.open = () => openReq();
})();`;

/* ------------------------------------------------------------------ */

function json(obj, status = 200, headers = {}) {
  return { status, contentType: "application/json", body: JSON.stringify(obj), headers };
}

async function fulfill(route, spec) {
  if (spec.delay) await new Promise((r) => setTimeout(r, spec.delay));
  if (spec.abort) return route.abort(spec.abort === true ? "failed" : spec.abort);
  await route.fulfill({
    status: spec.status || 200,
    contentType: spec.contentType || (spec.json ? "application/json" : "text/plain"),
    headers: spec.headers || {},
    body: spec.json !== undefined ? JSON.stringify(spec.json) : (spec.body !== undefined ? spec.body : ""),
  });
}

/* ------------------------------------------------------------------ */

class App {
  constructor(context, page, state, opts) {
    this.context = context;
    this.page = page;
    this.state = state;         // { requests: [...] }
    this.opts = opts;
    this.pageErrors = [];
    this.consoleErrors = [];
  }

  get requests() { return this.state.requests; }
  /* Every request that went to graph.microsoft.com, in order. */
  graph(filter) {
    const all = this.state.requests.filter((r) => r.url.startsWith(GRAPH_ORIGIN));
    return filter ? all.filter((r) => filter.test(r.url)) : all;
  }
  thumbs(filter) {
    const all = this.state.requests.filter((r) => r.url.startsWith("https://thumbs.example"));
    return filter ? all.filter((r) => filter.test(r.url)) : all;
  }
  clearRequests() { this.state.requests.length = 0; }

  async goto(waitForBoot = true) {
    await this.page.goto(env.baseURL, { waitUntil: "domcontentloaded" });
    if (waitForBoot) await this.waitForBoot();
    return this;
  }
  async reload(waitForBoot = true) {
    await this.page.reload({ waitUntil: "domcontentloaded" });
    if (waitForBoot) await this.waitForBoot();
    return this;
  }

  /* Boot is over when the splash is gone. */
  async waitForBoot(timeout = 20000) {
    await this.page.waitForFunction(
      () => getComputedStyle(document.getElementById("boot")).display === "none",
      undefined, { timeout, polling: 50 });
  }

  /* Resolves once a (re)scan has actually begun — use before waitForScan()
     when you have just triggered one, or you may match the previous run's
     "Scan complete" text. */
  async waitForScanStart(timeout = 10000) {
    await this.page.waitForFunction(() => typeof scanning !== "undefined" && scanning === true,
      undefined, { timeout, polling: 20 });
  }

  /* Kick off a forced rescan the way the Rescan button does, without waiting
     for it to finish. */
  async rescan() {
    await this.page.evaluate(() => { startGallery(true); });
    await this.waitForScanStart();
  }

  /* Resolves once the scan loop has settled (complete, up-to-date, or failed). */
  async waitForScan(timeout = 30000) {
    await this.page.waitForFunction(() => {
      const t = document.getElementById("scanText").textContent || "";
      return typeof scanning !== "undefined" && scanning === false &&
             /Scan complete|Up to date|Paused|Couldn't/.test(t);
    }, undefined, { timeout, polling: 50 });
    return this.scanText();
  }

  scanText() { return this.page.textContent("#scanText"); }
  countText() { return this.page.textContent("#count"); }
  cellCount() { return this.page.locator(".cell").count(); }
  monthHeaders() { return this.page.$$eval(".month", (els) => els.map((e) => e.textContent)); }
  viewNames() { return this.page.evaluate(() => view.map((p) => p.name)); }
  photoNames() { return this.page.evaluate(() => photos.map((p) => p.name)); }
  visible(id) {
    return this.page.evaluate((i) => {
      const el = document.getElementById(i);
      return !!el && getComputedStyle(el).display !== "none";
    }, id);
  }
  screens() { return this.page.evaluate(() => window.__screens); }
  msalCalls() { return this.page.evaluate(() => (window.__msal && window.__msal.calls) || []); }

  /* --- folder explorer --- */
  async openFolderPanel() {
    await this.page.evaluate(() => openFolders());
    await this.page.waitForSelector("#folders.open", { state: "attached" });
  }
  folderRows() {
    return this.page.$$eval("#folderTreeEl .fld", (rows) =>
      rows.map((r) => {
        const cb = r.querySelector('input[type=checkbox]');
        return {
          name: (r.querySelector(".nm").textContent || "").trim(),
          count: (r.querySelector(".ct").textContent || "").trim(),
          off: r.classList.contains("off"),
          nomedia: r.classList.contains("nomedia"),
          root: r.classList.contains("root"),
          queued: r.classList.contains("queued"),
          busy: r.classList.contains("busy"),
          busyUnder: r.classList.contains("busy-under"),
          checked: !!cb && cb.checked,
          disabled: !!cb && cb.disabled,
          indeterminate: !!cb && cb.indeterminate,
          chevron: !!r.querySelector(".tw svg"),
          indent: parseInt(r.style.paddingLeft, 10) || 0,
        };
      }));
  }
  async toggleFolder(name, on) {
    await this.page.evaluate(({ name, on }) => {
      const rows = [...document.querySelectorAll("#folderTreeEl .fld")];
      const row = rows.find((r) => (r.querySelector(".nm").textContent || "").trim().startsWith(name));
      if (!row) throw new Error("no folder row named " + name);
      const cb = row.querySelector("input[type=checkbox]");
      cb.checked = on;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    }, { name, on });
  }
  hiddenPaths() { return this.page.evaluate(() => hiddenPaths.slice()); }
  excludedPaths() { return this.page.evaluate(() => excludedPaths.slice()); }
  /* Expand tree nodes so their rows are rendered. */
  async expand(...paths) {
    await this.page.evaluate((ps) => { for (const p of ps) treeOpen.add(p); renderFolderTree(); }, paths);
  }
  folderRow(name) {
    return this.folderRows().then((rows) =>
      rows.find((r) => r.name === name || r.name.startsWith(name + " ")) || null);
  }

  /* --- storage --- */
  idb(key) {
    return this.page.evaluate((k) => idbGet(k), key);
  }

  async close() {
    try { await this.context.close(); } catch (e) { /* already gone */ }
  }
}

/* ------------------------------------------------------------------ */

async function launchApp(opts = {}) {
  const drive = opts.drive || null;
  const state = { requests: [], graphCount: 0 };
  const context = await env.browser.newContext({
    serviceWorkers: opts.serviceWorkers || "block",
    viewport: opts.viewport || { width: 420, height: 900 },
  });
  const page = await context.newPage();
  const app = new App(context, page, state, opts);

  page.on("pageerror", (e) => app.pageErrors.push(String((e && e.message) || e)));
  page.on("console", (m) => { if (m.type() === "error") app.consoleErrors.push(m.text()); });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  /* ---- init scripts (run before the app's inline script) ---- */
  await page.addInitScript(SCREEN_TRACKER);
  if (opts.standalone) await page.addInitScript(STANDALONE);
  if (opts.blockIndexedDB) await page.addInitScript(IDB_HANG);
  if (opts.localStorage) {
    await page.addInitScript((kv) => {
      try { for (const k of Object.keys(kv)) localStorage.setItem(k, kv[k]); } catch (e) {}
    }, opts.localStorage);
  }
  if (!opts.msalLoadFails) await page.addInitScript(msalStubSource(opts.msal || {}));
  for (const s of opts.initScripts || []) await page.addInitScript(s);

  /* ---- one catch-all route; dispatch by origin ---- */
  await page.route("**/*", async (route) => {
    const request = route.request();
    const href = request.url();
    const method = request.method();
    state.requests.push({ method, url: href, t: Date.now() });

    try {
      if (href.startsWith(env.baseURL) || href.startsWith("http://127.0.0.1")) {
        return await route.continue();
      }
      if (href.startsWith(GRAPH_ORIGIN)) {
        state.graphCount++;
        return await handleGraph(route, href, method, drive, opts, state);
      }
      if (CDN_RE.test(href)) {
        return await fulfill(route, {
          contentType: "application/javascript",
          body: msalStubSource(opts.msal || {}),
        });
      }
      if (href.startsWith("https://thumbs.example") || href.startsWith("https://dl.example")) {
        const spec = opts.thumb && opts.thumb({ url: href, state });
        if (spec) return await fulfill(route, spec);
        return await fulfill(route, { contentType: "image/png", body: PNG });
      }
      if (href.startsWith("https://login.microsoftonline.com")) {
        return await fulfill(route, json({ issuer: "https://login.microsoftonline.com/consumers/v2.0" }));
      }
      /* anything else the app might reach for: fail fast rather than hang */
      return await route.abort("failed");
    } catch (e) {
      /* page/context torn down mid-flight — nothing useful to do */
    }
  });

  return app;
}

/* ---- Microsoft Graph mock ---- */
async function handleGraph(route, href, method, drive, opts, state) {
  const u = new URL(href);
  const p = u.pathname;
  const ctx = { url: u, href, method, path: p, params: u.searchParams, state, drive };

  /* per-test hook wins */
  if (opts.graph) {
    const spec = await opts.graph(ctx);
    if (spec) return fulfill(route, spec);
  }

  if (p === "/v1.0/$metadata") return fulfill(route, { body: "<edmx/>", contentType: "application/xml" });
  if (p === "/v1.0/me") return fulfill(route, json(Object.assign({}, DEFAULT_ME, opts.me || {})));
  if (p === "/v1.0/me/photo/$value") return fulfill(route, { status: 404, body: "no photo" });
  if (p === "/v1.0/me/drive") return fulfill(route, json({ id: "drive1", driveType: "personal" }));

  if (p === "/v1.0/me/drive/root/delta") {
    const token = u.searchParams.get("token") || u.searchParams.get("$skiptoken") || "latest";
    if (opts.delta) {
      const spec = await opts.delta(token, ctx);
      if (spec) return fulfill(route, spec);
    }
    return fulfill(route, json({ value: [], "@odata.deltaLink": DELTA_BASE + "?token=D1" }));
  }

  let m = p.match(/^\/v1\.0\/me\/drive\/items\/([^/]+)\/children$/);
  if (m) return fulfill(route, listing(drive, m[1], u));
  if (p === "/v1.0/me/drive/root/children") return fulfill(route, listing(drive, "root", u));

  m = p.match(/^\/v1\.0\/me\/drive\/items\/([^/]+)\/thumbnails\/0$/);
  if (m) {
    const id = m[1];
    const item = drive && drive.itemsById.get(id);
    const t = item && item.thumbnails && item.thumbnails[0];
    if (!t) return fulfill(route, { status: 404, json: { error: { code: "itemNotFound" } } });
    return fulfill(route, json(t));
  }

  m = p.match(/^\/v1\.0\/me\/drive\/items\/([^/]+)$/);
  if (m) {
    const item = drive && drive.itemsById.get(m[1]);
    return fulfill(route, json({ "@microsoft.graph.downloadUrl": (item && item["@microsoft.graph.downloadUrl"]) || null }));
  }

  return fulfill(route, { status: 404, json: { error: { code: "itemNotFound", message: p } } });
}

/* Honour $top / $skiptoken so folder paging is exercised the way Graph does it. */
function listing(drive, id, u) {
  if (!drive) return json({ value: [] });
  const all = drive.children(id);
  const top = parseInt(u.searchParams.get("$top") || "200", 10);
  const skip = parseInt(u.searchParams.get("$skiptoken") || "0", 10);
  const page = all.slice(skip, skip + top);
  const body = { value: page };
  if (skip + top < all.length) {
    const next = new URL(u.href);
    next.searchParams.set("$skiptoken", String(skip + top));
    body["@odata.nextLink"] = next.href;
  }
  return json(body);
}

module.exports = { launchApp, App, GRAPH, GRAPH_ORIGIN, DELTA_BASE, json, DEFAULT_ME };
