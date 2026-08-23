"use strict";
/* Load / boot behaviour — the highest-value checks. A single `const` used
   before its declaration once took the whole app down, so "did it load at
   all, with no uncaught errors, and did it leave the splash" is asserted
   first and separately. */

const fs = require("fs");
const path = require("path");
const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");
const env = require("./lib/env");

const INDEX = path.resolve(__dirname, "..", "index.html");

test("1 · page loads with zero uncaught page errors (signed in, full scan)", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    assert.deepEq(app.pageErrors, [], "uncaught page errors");
  } finally { await app.close(); }
});

test("1b · page loads with zero uncaught page errors (signed out)", async () => {
  const app = await launchApp({ drive: demoDrive(), msal: { accounts: [] } });
  try {
    await app.goto();
    assert.deepEq(app.pageErrors, [], "uncaught page errors");
  } finally { await app.close(); }
});

test("2 · never gets stuck on the boot splash — ends on setup or gallery", async () => {
  for (const accounts of [undefined, []]) {
    const app = await launchApp({ drive: demoDrive(), msal: { accounts } });
    try {
      await app.goto();
      assert.eq(await app.visible("boot"), false, "#boot still visible");
      const setup = await app.visible("setup");
      const gallery = await app.visible("gallery");
      assert.ok(setup || gallery, "neither #setup nor #gallery is showing");
    } finally { await app.close(); }
  }
});

test("3 · every id the script looks up exists in the HTML (static wiring check)", async () => {
  const src = fs.readFileSync(INDEX, "utf8");
  const script = src.slice(src.indexOf("<script>"));
  const used = new Set();
  for (const m of script.matchAll(/\$\(\s*["']([^"']+)["']\s*\)/g)) used.add(m[1]);
  for (const m of script.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) used.add(m[1]);
  for (const m of script.matchAll(/querySelector\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g)) used.add(m[1]);

  const have = new Set();
  for (const m of src.matchAll(/\sid="([^"]+)"/g)) have.add(m[1]);

  assert.gte(used.size, 40, "the id scraper found suspiciously few lookups");
  const missing = [...used].filter((id) => !have.has(id));
  assert.deepEq(missing, [], "ids referenced by the script but absent from the HTML");
});

test("3b · nothing in the app fetches a second copy of an id-less element", async () => {
  /* Companion to the static check: at runtime, no $() call may return null. */
  const app = await launchApp({ drive: demoDrive() });
  try {
    await page_assertNoNullLookups(app);
  } finally { await app.close(); }
});

async function page_assertNoNullLookups(app) {
  await app.page.addInitScript(`(() => {
    window.__nullIds = [];
    const orig = document.getElementById.bind(document);
    document.getElementById = (id) => { const el = orig(id); if (!el) window.__nullIds.push(id); return el; };
  })();`);
  await app.goto();
  await app.waitForScan();
  await app.page.evaluate(() => { openFolders(); closeFolders(); openDiag(); closeDiag(); setMenu(true); setMenu(false); });
  const nulls = await app.page.evaluate(() => window.__nullIds);
  assert.deepEq([...new Set(nulls)], [], "getElementById returned null for these ids");
}

test("4 · signed-in stub goes straight to the gallery; the setup screen never flashes", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    assert.eq(await app.visible("gallery"), true, "#gallery not shown");
    const s = await app.screens();
    assert.gte(s.frames, 5, "the frame tracker never ran");
    assert.eq(s.setupEverShown, false, "#setup was displayed at some point");
  } finally { await app.close(); }
});

test("4b · signed-out stub shows the connect screen, not the gallery", async () => {
  const app = await launchApp({ drive: demoDrive(), msal: { accounts: [] } });
  try {
    await app.goto();
    assert.eq(await app.visible("setup"), true, "#setup not shown");
    assert.eq(await app.visible("gallery"), false, "#gallery shown while signed out");
    const s = await app.screens();
    assert.eq(s.galleryEverShown, false, "#gallery flashed while signed out");
  } finally { await app.close(); }
});

test("4c · the app never reaches the real MSAL CDN (stub is in place)", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    const cdn = app.requests.filter((r) => /msal-browser/.test(r.url));
    assert.deepEq(cdn, [], "requests to the MSAL CDN");
    const calls = (await app.msalCalls()).map((c) => c.m);
    assert.includes(calls, "initialize");
    assert.includes(calls, "handleRedirectPromise");
    assert.includes(calls, "acquireTokenSilent");
  } finally { await app.close(); }
});
