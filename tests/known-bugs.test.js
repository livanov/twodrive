"use strict";
/* Reproductions of bugs found while writing this suite.
 *
 * They are registered with test.skip(...) so the suite stays green — the app
 * author fixes the app, then deletes the `.skip` to turn each one into a
 * regression test. Every reproduction below was run and confirmed to fail
 * against index.html as of 2026-08-23; see tests/README.md for the write-up.
 */

const { test, assert } = require("./lib/tiny");
const { launchApp, DELTA_BASE } = require("./lib/harness");
const { demoDrive, nomediaDrive } = require("./lib/drives");
const { buildDrive, file, thumbSet } = require("./lib/fixtures");

/* ------------------------------------------------------------------ *
 * BUG 1 — turning ".nomedia" off and rescanning does not reveal the
 * photos, even though the app's own toast tells you to rescan.
 *
 * The first scan honours the marker, so the folder holds 0 photos, so
 * autoHideEmptyFolders() unticks it and records it in `autoHidden`.
 * Nothing ever removes it again: the rescan fetches the photos (they are
 * in `photos`) but buildView() filters them out via hiddenPaths.
 * ------------------------------------------------------------------ */
test.skip(
  "BUG1 · turning off .nomedia and rescanning reveals the marked photos",
  "app bug: the folder was auto-unticked for being empty while the marker was honoured, and is never un-hidden (index.html, autoHideEmptyFolders)",
  async () => {
    const app = await launchApp({ drive: nomediaDrive() });
    try {
      await app.goto();
      await app.waitForScan();
      assert.deepEq((await app.viewNames()).sort(), ["keep.jpg", "vis.jpg"]);
      assert.includes(await app.hiddenPaths(), "/drive/root:/Hidden",
        "precondition: the marked folder gets auto-unticked");

      /* The user follows the app's own advice: switch the option off, rescan. */
      await app.openFolderPanel();
      await app.page.click("#fldCog");
      await app.page.click("#nomediaToggle");
      await app.page.waitForTimeout(150);
      assert.match(await app.page.textContent("#toast"), /Rescan to load photos/);
      await app.page.click("#fldBackdrop");
      await app.page.click("#fldRescan");
      await app.waitForScanStart();
      await app.waitForScan(25000);

      /* The photos were fetched… */
      assert.deepEq((await app.photoNames()).sort(), ["keep.jpg", "nm1.jpg", "nm2.jpg", "vis.jpg"]);
      /* …but the timeline must show them too. */
      assert.deepEq((await app.viewNames()).sort(), ["keep.jpg", "nm1.jpg", "nm2.jpg", "vis.jpg"],
        "the rescan the app asked for did not reveal the photos");
    } finally { await app.close(); }
  });

/* ------------------------------------------------------------------ *
 * BUG 2 — a folder created after the last full scan never joins the
 * folder tree. deltaSync() adds the photo but never appends to
 * `folderTree`, so buildFolderIndex() has no node for its path: the
 * photo is missing from every folder count and there is no row to untick.
 * ------------------------------------------------------------------ */
test.skip(
  "BUG2 · a folder that arrives via delta appears in the folder explorer",
  "app bug: deltaSync() never records new folders in folderTree, so per-folder counts under-report and the folder cannot be hidden (index.html, deltaSync)",
  async () => {
    const drive = demoDrive();
    const item = {
      id: "nf1", name: "in-new-folder.jpg", size: 9,
      file: { mimeType: "image/jpeg" }, image: {},
      photo: { takenDateTime: "2026-01-01T00:00:00Z" },
      lastModifiedDateTime: "2026-01-01T00:00:00Z",
      parentReference: { driveId: "drive1", id: "fNEW", path: "/drive/root:/Brand New" },
      thumbnails: thumbSet("nf1"),
      "@microsoft.graph.downloadUrl": "https://dl.example/d/nf1.jpg",
    };
    const app = await launchApp({
      drive,
      delta: (t) => t === "D1" ? { json: { value: [item], "@odata.deltaLink": DELTA_BASE + "?token=D2" } } : null,
    });
    try {
      await app.goto();
      await app.waitForScan();
      await app.page.waitForFunction(async () => {
        const c = await idbGet(cacheKey); return !!(c && c.deltaLink);
      }, undefined, { timeout: 10000, polling: 200 });

      await app.reload();
      await app.waitForScan();
      assert.eq((await app.viewNames()).length, 6, "precondition: the delta photo is in the timeline");

      await app.openFolderPanel();
      await app.expand("/drive/root:");
      const rows = await app.folderRows();
      const root = rows.find((r) => r.name === "OneDrive");
      assert.eq(root.count, "6", "the root count must include photos found by the delta sync");
      assert.ok(rows.some((r) => r.name === "Brand New"),
        "a folder created since the last full scan should be listed so it can be hidden");
    } finally { await app.close(); }
  });

/* ------------------------------------------------------------------ *
 * BUG 3 — the empty-state panel is destroyed by the first scan failure.
 * The error branch does $("empty").innerHTML = "<h2>Couldn't load…", so a
 * later successful scan that legitimately finds nothing still shows the
 * stale error instead of "No photos found".
 * ------------------------------------------------------------------ */
test.skip(
  "BUG3 · the empty state recovers after a failed scan is followed by a good one",
  "app bug: the failure branch overwrites #empty's markup permanently (index.html, startGallery catch block)",
  async () => {
    const drive = buildDrive([file("readme.txt")]);   // a drive with no photos at all
    const st = { fail: true };
    const app = await launchApp({
      drive,
      graph: (c) => (st.fail && /children/.test(c.path))
        ? { status: 500, json: { error: { code: "generalException" } } } : null,
    });
    try {
      await app.goto();
      await app.waitForScan(20000);
      assert.match(await app.page.textContent("#empty"), /Couldn't load photos/);

      st.fail = false;
      await app.rescan();
      await app.waitForScan(20000);
      assert.match(await app.scanText(), /Scan complete/);
      assert.eq(await app.visible("empty"), true);
      assert.match(await app.page.textContent("#empty"), /No photos found/,
        "after a successful scan of an empty drive the panel should say so, not repeat the old error");
    } finally { await app.close(); }
  });
