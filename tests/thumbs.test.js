"use strict";
/* Thumbnail self-healing, cell reuse, and the read-only guarantee. */

const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");

test("16 · a 403 thumbnail is refreshed once via the item's thumbnails endpoint", async () => {
  const drive = demoDrive();
  const badId = drive.imageByName.get("root-jun.jpg").id;
  let refreshCalls = 0;

  const app = await launchApp({
    drive,
    graph: (ctx) => {
      if (ctx.path === `/v1.0/me/drive/items/${badId}/thumbnails/0`) {
        refreshCalls++;
        const u = (s) => `https://thumbs.example/t/${badId}-${s}-fresh.png`;
        return { json: { id: "0", small: { url: u("s") }, medium: { url: u("m") }, large: { url: u("l") } } };
      }
      return null;
    },
    /* The cached/expired URL 403s; the freshly-issued one works. */
    thumb: ({ url }) => (url.includes(badId) && !url.includes("fresh"))
      ? { status: 403, body: "expired" } : null,
  });

  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForFunction((id) =>
      [...document.querySelectorAll(".cell img")].some((i) => i.src.includes(id) && i.src.includes("fresh")),
      badId, { timeout: 8000, polling: 50 });

    assert.eq(refreshCalls, 1, "expected exactly one on-demand thumbnail refresh");

    /* Re-render a few times: the self-heal must not turn into a loop. */
    for (let i = 0; i < 3; i++) {
      await app.page.evaluate(() => refreshTimeline(true));
      await app.page.waitForTimeout(150);
    }
    assert.eq(refreshCalls, 1, "the thumbnail refresh looped across re-renders");
    assert.eq(await app.cellCount(), 5);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("16b · a thumbnail that 403s twice gives up instead of hammering Graph", async () => {
  const drive = demoDrive();
  const badId = drive.imageByName.get("p1.jpg").id;
  let refreshCalls = 0;
  const app = await launchApp({
    drive,
    graph: (ctx) => {
      if (ctx.path === `/v1.0/me/drive/items/${badId}/thumbnails/0`) refreshCalls++;
      return null;   // hand back the same (still-403ing) urls
    },
    thumb: ({ url }) => url.includes(badId) ? { status: 403, body: "expired" } : null,
  });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForTimeout(1200);
    for (let i = 0; i < 3; i++) {
      await app.page.evaluate(() => refreshTimeline(true));
      await app.page.waitForTimeout(150);
    }
    assert.lte(refreshCalls, 1, "a permanently broken thumbnail must be retried at most once");
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("17 · cells are reused — a thumbnail URL is fetched once across re-renders", async () => {
  const drive = demoDrive();
  const app = await launchApp({ drive });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForFunction(() =>
      [...document.querySelectorAll(".cell img")].every((i) => i.complete && i.naturalWidth > 0),
      undefined, { timeout: 8000, polling: 50 });

    const before = app.thumbs().map((r) => r.url);
    const unique = new Set(before);
    assert.eq(before.length, unique.size, "a thumbnail was already fetched twice during the scan");
    assert.eq(unique.size, 5, "expected one thumbnail request per photo");

    const sample = before[0];
    const nodesBefore = await app.page.evaluate(() => cellCache.size);

    for (let i = 0; i < 4; i++) {
      await app.page.evaluate(() => refreshTimeline(true));
      await app.page.waitForTimeout(120);
    }
    await app.page.waitForTimeout(300);

    const after = app.thumbs().map((r) => r.url);
    assert.eq(after.filter((u) => u === sample).length, 1,
      "the same thumbnail URL was re-requested on a re-render");
    assert.eq(after.length, before.length, "re-rendering re-downloaded thumbnails");
    assert.eq(await app.page.evaluate(() => cellCache.size), nodesBefore, "cell cache churned");
    assert.eq(await app.cellCount(), 5);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("17b · cells survive a folder-visibility change without re-downloading", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForFunction(() => document.querySelectorAll(".cell img").length === 5,
      undefined, { timeout: 8000, polling: 50 });
    const before = app.thumbs().length;

    await app.page.evaluate((p) => setFolderVisible(p, false), "/drive/root:/Pictures");
    await app.page.waitForTimeout(200);
    await app.page.evaluate((p) => setFolderVisible(p, true), "/drive/root:/Pictures");
    await app.page.waitForTimeout(400);

    assert.eq(await app.cellCount(), 5, "cells missing after hide/show");
    assert.eq(app.thumbs().length, before, "hiding and re-showing re-downloaded thumbnails");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("18 · browsing never writes: scanning and the lightbox issue GETs only", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();

    /* Exercise the lightbox too — it resolves large images and download urls. */
    await app.page.click(".cell");
    await app.page.waitForFunction(() =>
      getComputedStyle(document.getElementById("lightbox")).display === "flex",
      undefined, { timeout: 5000 });
    await app.page.evaluate(() => step(1));
    await app.page.waitForTimeout(500);

    const nonGet = app.graph().filter((r) => r.method !== "GET");
    assert.deepEq(nonGet, [], "non-GET requests to graph.microsoft.com");
    assert.gte(app.graph().length, 5, "no Graph traffic at all — the test proved nothing");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("18b · browsing only ever asks for read scopes", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    const calls = await app.msalCalls();
    const scoped = calls.filter((c) => c.scopes);
    assert.gte(scoped.length, 1, "no token request was recorded");
    for (const c of scoped) {
      assert.deepEq(c.scopes, ["Files.Read", "User.Read"], `scopes for ${c.m}`);
    }
    /* Sign-in stays read-only; write access is a separate, later request. */
    const src = await app.page.evaluate(() => SCOPES.slice());
    assert.deepEq(src, ["Files.Read", "User.Read"]);
    const w = await app.page.evaluate(() => WRITE_SCOPES.slice());
    assert.deepEq(w, ["Files.ReadWrite"]);
    assert.eq(src.concat(w).some((s) => /All|Sites|Directory/.test(s)), false,
      "must never ask for tenant-wide or all-files scopes");
  } finally { await app.close(); }
}, { timeout: 40000 });
