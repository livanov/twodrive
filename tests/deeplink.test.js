"use strict";
/* Deep links: the open photo and the current tab live in the URL, so a reload
   returns to the same place. Also the honesty of the scanning chip. */

const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");

const lbOpen = (app) => app.page.waitForFunction(
  () => getComputedStyle(document.getElementById("lightbox")).display === "flex",
  undefined, { timeout: 6000 });

test("57 · opening a photo puts it in the URL, closing takes it out", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    assert.eq(await app.page.evaluate(() => location.hash), "", "hash dirty before opening");

    await app.page.click(".cell");
    await lbOpen(app);
    const hash = await app.page.evaluate(() => location.hash);
    assert.match(hash, /photo=/, "the open photo is not in the URL: " + hash);
    const shownId = await app.page.evaluate(() => view[lbIndex].id);
    assert.includes(decodeURIComponent(hash), shownId);

    await app.page.click("#lbClose");
    await app.page.waitForFunction(() => !location.hash.includes("photo="),
      undefined, { timeout: 5000 });
  } finally { await app.close(); }
}, { timeout: 40000 });

test("58 · reloading on a photo URL reopens that photo", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.click(".cell");
    await lbOpen(app);
    const id = await app.page.evaluate(() => view[lbIndex].id);
    const name = await app.page.textContent("#lbName");

    await app.reload();
    await app.waitForScan();
    await lbOpen(app);
    assert.eq(await app.page.evaluate(() => view[lbIndex].id), id,
      "a different photo (or none) was restored");
    assert.eq(await app.page.textContent("#lbName"), name);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("58b · Back from a restored photo returns to the gallery, not out of the app", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.click(".cell");
    await lbOpen(app);
    await app.reload();
    await app.waitForScan();
    await lbOpen(app);

    await app.page.goBack();
    await app.page.waitForFunction(
      () => getComputedStyle(document.getElementById("lightbox")).display === "none",
      undefined, { timeout: 5000 });
    /* still on the app, with the gallery showing */
    assert.eq(await app.visible("gallery"), true, "Back left the gallery");
    assert.gte(await app.cellCount(), 1);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("59 · the albums tab is a deep link too", async () => {
  const app = await launchApp({ drive: demoDrive(), bundles: [] });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.click("#tabAlbums");
    await app.page.waitForFunction(() => location.hash.includes("tab=albums"),
      undefined, { timeout: 5000 });

    await app.reload();
    await app.waitForScan();
    await app.page.waitForFunction(
      () => getComputedStyle(document.getElementById("albums")).display !== "none",
      undefined, { timeout: 6000 });
    assert.match(await app.page.getAttribute("#tabAlbums", "class"), /\bon\b/,
      "the albums tab was not restored");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("60 · a deep link to an unknown photo just shows the gallery", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.evaluate(() => { location.hash = "photo=does-not-exist"; });
    await app.reload();
    await app.waitForScan();
    await app.page.waitForTimeout(400);

    assert.eq(await app.page.isVisible("#lightbox"), false, "opened a lightbox for a missing photo");
    assert.gte(await app.cellCount(), 1);
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("61 · the scan chip says what is happening, and goes away when nothing is", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    /* while scanning it must never sit on the bare placeholder */
    await app.waitForScan();
    await app.page.waitForFunction(
      () => /complete|up to date/i.test(document.getElementById("scanText").textContent),
      undefined, { timeout: 10000, polling: 50 });
    /* and then it hides itself */
    await app.page.waitForFunction(
      () => getComputedStyle(document.getElementById("scanbar")).display === "none",
      undefined, { timeout: 10000, polling: 100 });
    assert.eq(await app.page.evaluate(() => scanning), false, "scanning flag stuck on");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("61b · a throttled scan reports the wait instead of a bare 'Scanning…'", async () => {
  let first = true;
  const app = await launchApp({
    drive: demoDrive(),
    graph: (ctx) => {
      /* Stall the very first folder listing behind a long-ish 429. */
      if (first && /children/.test(ctx.path)) {
        first = false;
        return { status: 429, headers: { "Retry-After": "3" }, json: { error: { code: "activityLimitReached" } } };
      }
      return null;
    },
  });
  try {
    await app.goto();
    await app.page.waitForFunction(
      () => /rate-limited|waiting for onedrive/i.test(document.getElementById("scanText").textContent),
      undefined, { timeout: 12000, polling: 100 });
    /* it recovers and finishes */
    await app.waitForScan(30000);
    assert.gte(await app.cellCount(), 1);
  } finally { await app.close(); }
}, { timeout: 50000 });
