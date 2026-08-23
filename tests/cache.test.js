"use strict";
/* IndexedDB cache + Graph delta sync: what a second launch does. */

const { test, assert } = require("./lib/tiny");
const { launchApp, DELTA_BASE } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");
const { thumbSet } = require("./lib/fixtures");

function newPhotoItem(id, name, taken) {
  return {
    id, name, size: 987,
    file: { mimeType: "image/jpeg" },
    image: { width: 100, height: 100 },
    photo: { takenDateTime: taken },
    lastModifiedDateTime: taken,
    parentReference: { driveId: "drive1", id: "root", path: "/drive/root:" },
    thumbnails: thumbSet(id),
    "@microsoft.graph.downloadUrl": `https://dl.example/d/${id}.jpg`,
  };
}

test("12 · a finished scan stores a delta token and the photo list in IndexedDB", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    /* persistCache() runs right after the walk; give the debounce a beat. */
    await app.page.waitForFunction(async () => {
      const c = await idbGet(cacheKey);
      return !!(c && c.photos && c.photos.length === 5 && c.deltaLink);
    }, undefined, { timeout: 10000, polling: 200 });

    const cached = await app.page.evaluate(() => idbGet(cacheKey));
    assert.eq(cached.photos.length, 5, "photos cached");
    assert.match(cached.deltaLink, /delta\?token=D1/, "delta token stored");
    assert.eq(cached.scanInfo.done, true, "scanInfo.done not persisted");
    assert.gte(cached.folderTree.length, 3, "folder tree not persisted");
    assert.ok(cached.photos[0].thumb, "cached record keeps its thumbnail url");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("13 · a second launch paints from cache and skips the folder walk", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForFunction(async () => {
      const c = await idbGet(cacheKey);
      return !!(c && c.deltaLink);
    }, undefined, { timeout: 10000, polling: 200 });

    app.clearRequests();
    await app.reload();
    /* Content is on screen before any sync finishes. */
    await app.page.waitForFunction(() => document.querySelectorAll(".cell").length === 5,
      undefined, { timeout: 8000, polling: 25 });
    const text = await app.waitForScan();

    assert.deepEq(app.graph(/children/), [], "second launch did a folder walk");
    assert.eq(app.graph(/\/root\/delta/).length, 1, "expected exactly one delta call");
    assert.match(text, /^Up to date · 5 photos$/);
    assert.eq(await app.cellCount(), 5);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("14 · a delta response adds a photo and a deleted entry removes one", async () => {
  const drive = demoDrive();
  const goneId = drive.imageByName.get("c1.jpg").id;
  const app = await launchApp({
    drive,
    delta: (token) => token === "D1" ? {
      json: {
        value: [
          newPhotoItem("new-1", "brand-new.jpg", "2026-02-03T10:00:00Z"),
          { id: goneId, name: "c1.jpg", file: { mimeType: "image/jpeg" }, deleted: { state: "deleted" } },
        ],
        "@odata.deltaLink": DELTA_BASE + "?token=D2",
      },
    } : null,
  });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForFunction(async () => {
      const c = await idbGet(cacheKey); return !!(c && c.deltaLink);
    }, undefined, { timeout: 10000, polling: 200 });

    app.clearRequests();
    await app.reload();
    await app.waitForScan();

    const names = (await app.viewNames()).sort();
    assert.deepEq(names, ["brand-new.jpg", "c2.jpg", "p1.jpg", "p2.jpg", "root-jun.jpg"]);
    assert.eq(await app.cellCount(), 5, "cells not rebuilt after the delta");
    /* Newest first: the 2026 arrival leads the timeline. */
    assert.eq((await app.viewNames())[0], "brand-new.jpg");
    assert.deepEq(app.graph(/children/), [], "a delta sync must not trigger a folder walk");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("14b · a non-image replacing a known image is dropped from the timeline", async () => {
  const drive = demoDrive();
  const id = drive.imageByName.get("p1.jpg").id;
  const app = await launchApp({
    drive,
    delta: (token) => token === "D1" ? {
      json: {
        value: [{
          id, name: "p1.txt", size: 5, file: { mimeType: "text/plain" },
          parentReference: { driveId: "drive1", id: "root", path: "/drive/root:" },
        }],
        "@odata.deltaLink": DELTA_BASE + "?token=D2",
      },
    } : null,
  });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForFunction(async () => {
      const c = await idbGet(cacheKey); return !!(c && c.deltaLink);
    }, undefined, { timeout: 10000, polling: 200 });
    await app.reload();
    await app.waitForScan();
    assert.eq((await app.viewNames()).includes("p1.jpg"), false, "p1.jpg should be gone");
    assert.eq((await app.viewNames()).length, 4);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("15 · a 410 delta token falls back to a full rescan", async () => {
  const drive = demoDrive();
  let delta410 = 0;
  const app = await launchApp({
    drive,
    delta: (token) => {
      if (token !== "D1") return null;
      delta410++;
      return { status: 410, json: { error: { code: "resyncRequired", message: "token expired" } } };
    },
  });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForFunction(async () => {
      const c = await idbGet(cacheKey); return !!(c && c.deltaLink);
    }, undefined, { timeout: 10000, polling: 200 });

    app.clearRequests();
    await app.reload();
    const text = await app.waitForScan(25000);

    assert.eq(delta410, 1, "the expired delta token was never used");
    assert.gte(app.graph(/children/).length, 3, "no full rescan after the 410");
    assert.match(text, /Scan complete/);
    assert.eq((await app.viewNames()).length, 5, "photos survived the resync");
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 60000 });

test("15b · cached photos paint before the delta call has even answered", async () => {
  const drive = demoDrive();
  const app = await launchApp({
    drive,
    delta: (token) => token === "D1" ? { delay: 2500, json: { value: [], "@odata.deltaLink": DELTA_BASE + "?token=D1" } } : null,
  });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.waitForFunction(async () => {
      const c = await idbGet(cacheKey); return !!(c && c.deltaLink);
    }, undefined, { timeout: 10000, polling: 200 });

    await app.reload();
    await app.page.waitForFunction(() => document.querySelectorAll(".cell").length === 5,
      undefined, { timeout: 5000, polling: 25 });
    /* Still syncing at this point — the grid came from IndexedDB, not Graph. */
    assert.match(await app.scanText(), /Checking for new photos|Syncing/);
    assert.eq(await app.page.evaluate(() => scanning), true);
    await app.waitForScan(20000);
    assert.eq((await app.viewNames()).length, 5);
  } finally { await app.close(); }
}, { timeout: 50000 });
