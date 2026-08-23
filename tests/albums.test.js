"use strict";
/* The Timeline / Albums tabs, and the album list itself. Albums come from
   OneDrive's "bundles" collection, filtered to those with an album facet. */

const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");

const album = (id, name, count, extra = {}) => ({
  id, name,
  bundle: { childCount: count, album: {} },
  lastModifiedDateTime: extra.modified || "2024-06-01T10:00:00Z",
  thumbnails: extra.noThumb ? [] : [{ id: "0",
    small: { url: `https://thumbs.example/a/${id}-s.png` },
    medium: { url: `https://thumbs.example/a/${id}-m.png` } }],
});
/* A bundle that is NOT an album — must be filtered out. */
const plainBundle = (id, name) => ({ id, name, bundle: { childCount: 2 } });

const openAlbums = async (app) => {
  await app.page.click("#tabAlbums");
  await app.page.waitForFunction(
    () => getComputedStyle(document.getElementById("albums")).display !== "none",
    undefined, { timeout: 5000 });
};

test("51 · the gallery has Timeline and Albums tabs, Timeline first", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();

    assert.eq(await app.page.isVisible("#tabTimeline"), true);
    assert.eq(await app.page.isVisible("#tabAlbums"), true);
    assert.match(await app.page.getAttribute("#tabTimeline", "class"), /\bon\b/,
      "Timeline should be the active tab on arrival");
    assert.eq(await app.page.isVisible("#albums"), false, "albums list showing before it was asked for");
    assert.gte(await app.cellCount(), 1, "the timeline should be the default view");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("52 · switching tabs swaps the timeline for the album list, and back", async () => {
  const app = await launchApp({
    drive: demoDrive(),
    bundles: [album("al-1", "Holiday 2024", 12)],
  });
  try {
    await app.goto();
    await app.waitForScan();
    await openAlbums(app);

    assert.eq(await app.page.isVisible("#stream"), false, "the timeline is still showing");
    assert.match(await app.page.getAttribute("#tabAlbums", "class"), /\bon\b/);
    await app.page.waitForSelector(".album", { timeout: 5000 });

    await app.page.click("#tabTimeline");
    await app.page.waitForTimeout(150);
    assert.eq(await app.page.isVisible("#albums"), false);
    assert.eq(await app.page.isVisible("#stream"), true, "the timeline did not come back");
    assert.gte(await app.cellCount(), 1);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("53 · albums are listed with a cover, name and item count", async () => {
  const app = await launchApp({
    drive: demoDrive(),
    bundles: [
      album("al-1", "Holiday 2024", 12, { modified: "2024-07-01T10:00:00Z" }),
      album("al-2", "Family", 1, { modified: "2024-08-01T10:00:00Z" }),
      plainBundle("b-9", "Not an album"),
    ],
  });
  try {
    await app.goto();
    await app.waitForScan();
    await openAlbums(app);
    await app.page.waitForSelector(".album", { timeout: 5000 });

    const rows = await app.page.$$eval(".album", (els) => els.map((e) => ({
      title: e.querySelector(".t").textContent,
      sub: e.querySelector(".s").textContent,
      cover: (e.querySelector("img.cover") || {}).src || null,
    })));

    assert.eq(rows.length, 2, "non-album bundles must be filtered out: " + JSON.stringify(rows));
    /* newest first */
    assert.eq(rows[0].title, "Family");
    assert.eq(rows[1].title, "Holiday 2024");
    assert.match(rows[1].sub, /12 items/);
    assert.match(rows[0].sub, /1 item(?!s)/, "count should be singular for one item: " + rows[0].sub);
    assert.ok(rows[0].cover && rows[0].cover.includes("al-2"), "album cover missing: " + rows[0].cover);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("54 · an account with no albums says so instead of showing an empty page", async () => {
  const app = await launchApp({ drive: demoDrive(), bundles: [] });
  try {
    await app.goto();
    await app.waitForScan();
    await openAlbums(app);
    await app.page.waitForFunction(
      () => /no albums/i.test(document.getElementById("albums").textContent),
      undefined, { timeout: 8000, polling: 50 });
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("55 · a failing albums call explains itself and leaves the timeline usable", async () => {
  const app = await launchApp({ drive: demoDrive(), bundles: "error" });
  try {
    await app.goto();
    await app.waitForScan();
    await openAlbums(app);
    await app.page.waitForFunction(
      () => /couldn.t load albums/i.test(document.getElementById("albums").textContent),
      undefined, { timeout: 10000, polling: 50 });

    await app.page.click("#tabTimeline");
    await app.page.waitForTimeout(150);
    assert.gte(await app.cellCount(), 1, "the timeline broke after an albums failure");
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("56 · albums are fetched only when the tab is opened, and only once", async () => {
  const app = await launchApp({
    drive: demoDrive(),
    bundles: [album("al-1", "Holiday 2024", 3)],
  });
  try {
    await app.goto();
    await app.waitForScan();
    const bundleCalls = () => app.graph(/bundles/).length;
    assert.eq(bundleCalls(), 0, "albums were fetched before the tab was opened");

    await openAlbums(app);
    await app.page.waitForSelector(".album", { timeout: 5000 });
    assert.eq(bundleCalls(), 1);

    /* flip away and back — the cached list is reused */
    await app.page.click("#tabTimeline");
    await app.page.waitForTimeout(100);
    await app.page.click("#tabAlbums");
    await app.page.waitForTimeout(300);
    assert.eq(bundleCalls(), 1, "re-opening the tab refetched the albums");
  } finally { await app.close(); }
}, { timeout: 40000 });
