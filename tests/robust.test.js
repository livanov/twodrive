"use strict";
/* Degraded environments: no usable IndexedDB, and a startup that never
   finishes. Neither may leave the user staring at the splash. */

const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");

test("42 · the app still starts when IndexedDB never answers", async () => {
  /* indexedDB.open() returns a request whose events never fire — the app's
     own 4s timeout has to carry it through. */
  const app = await launchApp({ drive: demoDrive(), blockIndexedDB: true });
  try {
    const t0 = Date.now();
    await app.goto(false);
    await app.waitForBoot(20000);
    assert.eq(await app.visible("gallery"), true, "no gallery after IndexedDB stalled");
    assert.eq(await app.visible("boot"), false);

    await app.waitForScan(30000);
    assert.eq((await app.viewNames()).length, 5, "the scan should still work without a cache");
    assert.deepEq(app.pageErrors, []);

    const log = await app.page.evaluate(() => LOG.join("\n"));
    assert.match(log, /indexedDB open timed out/, "the timeout was not logged for diagnostics");
    /* Recorded for the report: how long the cache timeout delays the gallery. */
    assert.lte(Date.now() - t0, 20000, "startup took longer than the boot watchdog allows");
  } finally { await app.close(); }
}, { timeout: 60000 });

test("42b · a rejected IndexedDB open does not stop the gallery", async () => {
  const app = await launchApp({
    drive: demoDrive(),
    initScripts: [`indexedDB.open = () => {
      const r = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, error: new Error("nope") };
      setTimeout(() => r.onerror && r.onerror(), 0);
      return r;
    };`],
  });
  try {
    await app.goto();
    await app.waitForScan(25000);
    assert.eq(await app.visible("gallery"), true);
    assert.eq((await app.viewNames()).length, 5);
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("43 · the boot watchdog falls back to the setup screen if startup stalls", async () => {
  /* handleRedirectPromise() never resolves — the classic "stuck on splash". */
  const app = await launchApp({ drive: demoDrive(), msal: { hangAt: "handleRedirectPromise" } });
  try {
    await app.goto(false);
    /* Still on the splash to begin with. */
    await app.page.waitForTimeout(1000);
    assert.eq(await app.visible("boot"), true, "the splash should still be up while startup hangs");

    await app.waitForBoot(25000);
    assert.eq(await app.visible("setup"), true, "the watchdog did not fall back to the setup screen");
    assert.eq(await app.visible("boot"), false);
    assert.eq(await app.visible("setupErr"), true, "no explanation was shown");
    assert.match(await app.page.textContent("#setupErr"), /taking too long|stuck/i);
    /* Diagnostics is reachable from there, which is the whole point. */
    await app.page.click("#diagBtn");
    await app.page.waitForSelector("#diag.open");
    const log = await app.page.evaluate(() => LOG.join("\n"));
    assert.match(log, /watchdog/i, "the watchdog did not log anything");
  } finally { await app.close(); }
}, { timeout: 60000 });

test("43b · a sign-in library that will not load lands on setup with an error, not the splash", async () => {
  /* No window.msal and every CDN aborted: loadMsal() must reject and the
     boot catch must show the connect screen. */
  const app = await launchApp({
    drive: demoDrive(),
    msalLoadFails: true,
    graph: () => ({ abort: true }),
  });
  try {
    await app.page.route(/msal-browser/, (route) => route.abort("failed"));
    await app.goto(false);
    await app.waitForBoot(25000);
    assert.eq(await app.visible("setup"), true, "should fall back to the connect screen");
    assert.eq(await app.visible("setupErr"), true);
    assert.match(await app.page.textContent("#setupErr"), /Couldn't (restore|load)/i);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("43x · an unreachable Graph shows an explanation instead of an empty grid", async () => {
  const app = await launchApp({
    drive: demoDrive(),
    graph: (ctx) => /children|delta/.test(ctx.path)
      ? { status: 500, json: { error: { code: "generalException" } } } : null,
  });
  try {
    await app.goto();
    await app.waitForScan(30000);
    assert.eq(await app.visible("gallery"), true);
    assert.eq(await app.visible("empty"), true, "no explanation for the failed scan");
    assert.match(await app.page.textContent("#empty"), /Couldn't load photos/);
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });
