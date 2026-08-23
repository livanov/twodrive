"use strict";
/* .nomedia handling and the folder explorer: the tree, per-folder counts,
   cascading visibility, auto-hiding of empty folders, and the two option
   switches. */

const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive, nomediaDrive, twoBranchDrive } = require("./lib/drives");
const { buildDrive, folder, image, file, nomedia } = require("./lib/fixtures");

const ROOT = "/drive/root:";
const P = (...parts) => ROOT + (parts.length ? "/" + parts.join("/") : "");

test("19 · a .nomedia folder and its whole subtree are excluded", async () => {
  const app = await launchApp({ drive: nomediaDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    assert.deepEq((await app.viewNames()).sort(), ["keep.jpg", "vis.jpg"]);
    assert.includes(await app.excludedPaths(), P("Hidden"), "the .nomedia folder was not recorded");
    const tree = await app.page.evaluate(() => folderTree.map((f) => f.path));
    assert.includes(tree, P("Hidden"), "the marked folder itself should still be listed");
    assert.eq(tree.includes(P("Hidden", "HiddenSub")), false,
      "the subtree below a .nomedia folder must not be walked");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("20 · the .nomedia switch changes what the timeline shows, both ways", async () => {
  /* Start with the switch off so the marked photos are actually scanned. */
  const app = await launchApp({ drive: nomediaDrive(), localStorage: { lumen_nomedia: "0" } });
  try {
    await app.goto();
    await app.waitForScan();
    assert.eq(await app.page.evaluate(() => honorNomedia), false);
    assert.deepEq((await app.viewNames()).sort(), ["keep.jpg", "nm1.jpg", "nm2.jpg", "vis.jpg"]);
    assert.includes(await app.excludedPaths(), P("Hidden"), "the marker is recorded even when ignored");

    await app.openFolderPanel();
    await app.page.click("#fldCog");
    await app.page.click("#nomediaToggle");
    await app.page.waitForTimeout(150);
    assert.eq(await app.page.evaluate(() => honorNomedia), true);
    assert.deepEq((await app.viewNames()).sort(), ["keep.jpg", "vis.jpg"], "switching on did not hide them");

    await app.page.click("#nomediaToggle");
    await app.page.waitForTimeout(150);
    assert.deepEq((await app.viewNames()).sort(), ["keep.jpg", "nm1.jpg", "nm2.jpg", "vis.jpg"],
      "switching off did not bring them back");
    assert.eq(await app.page.evaluate(() => lsGet("lumen_nomedia")), "0", "preference not persisted");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("21 · the folder tree renders with counts rolled up over descendants", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    await app.expand(ROOT, P("Pictures"));

    const rows = await app.folderRows();
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.ok(by["OneDrive"], "no root row: " + JSON.stringify(rows.map((r) => r.name)));
    assert.eq(by["OneDrive"].count, "5", "root count should roll up every photo");
    assert.eq(by["OneDrive"].root, true);
    assert.ok(by["Pictures"], "no Pictures row");
    assert.eq(by["Pictures"].count, "4", "Pictures = 2 direct + 2 in Camera Roll");
    assert.ok(by["Camera Roll"], "no Camera Roll row");
    assert.eq(by["Camera Roll"].count, "2");
    /* nesting is expressed with indentation */
    assert.gte(by["Camera Roll"].indent, by["Pictures"].indent + 10);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("22 · unticking a folder hides its subtree at once, and it sticks across a reload", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    await app.expand(ROOT);

    await app.toggleFolder("Pictures", false);
    await app.page.waitForTimeout(150);
    assert.deepEq(await app.viewNames(), ["root-jun.jpg"], "subtree not hidden immediately");
    assert.eq(await app.cellCount(), 1);
    assert.includes(await app.hiddenPaths(), P("Pictures"));
    /* no rescan was needed */
    const before = app.graph(/children/).length;

    await app.reload();
    await app.waitForScan();
    assert.deepEq(await app.viewNames(), ["root-jun.jpg"], "hiding did not survive the reload");
    assert.eq(app.graph(/children/).length, before, "hiding triggered a rescan");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("23 · ticking a parent cascades: the whole subtree comes back", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    await app.expand(ROOT, P("Pictures"));

    /* hide a leaf, then its parent */
    await app.toggleFolder("Camera Roll", false);
    await app.page.waitForTimeout(100);
    assert.deepEq((await app.viewNames()).sort(), ["p1.jpg", "p2.jpg", "root-jun.jpg"]);
    await app.toggleFolder("Pictures", false);
    await app.page.waitForTimeout(100);
    assert.deepEq(await app.viewNames(), ["root-jun.jpg"]);

    /* ticking the parent restores everything below it, including the leaf
       that had been hidden on its own */
    await app.toggleFolder("Pictures", true);
    await app.page.waitForTimeout(150);
    assert.eq((await app.viewNames()).length, 5, "cascade did not restore the leaf");
    /* Only the ticked subtree is cleared. Siblings auto-unticked for being
       empty at scan time must stay hidden — that is a separate feature. */
    const under = (await app.hiddenPaths())
      .filter((p) => p === P("Pictures") || p.startsWith(P("Pictures") + "/"));
    assert.deepEq(under, [], "hiddenPaths not cleared under the ticked parent");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("23b · ticking the root unhides everything", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    await app.expand(ROOT, P("Pictures"));
    await app.toggleFolder("Camera Roll", false);
    await app.page.waitForTimeout(100);
    assert.eq((await app.viewNames()).length, 3);

    /* Documents and Empty were auto-unticked for holding no photos. */
    assert.gte((await app.hiddenPaths()).length, 2);
    await app.toggleFolder("OneDrive", true);
    await app.page.waitForTimeout(150);
    assert.deepEq(await app.hiddenPaths(), [], "root tick must clear every hidden path");
    assert.eq((await app.viewNames()).length, 5);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("24 · a folder with a hidden descendant shows an indeterminate checkbox", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    await app.expand(ROOT, P("Pictures"));

    let pictures = await app.folderRow("Pictures");
    assert.eq(pictures.indeterminate, false, "nothing hidden yet");

    await app.toggleFolder("Camera Roll", false);
    await app.page.waitForTimeout(150);

    pictures = await app.folderRow("Pictures");
    assert.eq(pictures.checked, true, "the parent itself is still ticked");
    assert.eq(pictures.indeterminate, true, "parent should be partly ticked");
    const cr = await app.folderRow("Camera Roll");
    assert.eq(cr.checked, false);
    assert.eq(cr.off, true, "hidden folders are struck through");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("24b · children of an unticked folder are shown disabled, not editable", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    await app.expand(ROOT, P("Pictures"));
    await app.toggleFolder("Pictures", false);
    await app.page.waitForTimeout(150);
    const cr = await app.folderRow("Camera Roll");
    assert.eq(cr.checked, false);
    assert.eq(cr.disabled, true, "a child of a hidden folder should not be individually tickable");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("25 · empty folders are auto-unticked; a folder you tick back stays ticked after a rescan", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();

    let hidden = await app.hiddenPaths();
    assert.includes(hidden, P("Empty"), "an empty folder should start unticked");
    assert.includes(hidden, P("Documents"), "a folder with no images should start unticked");
    assert.includes(await app.page.evaluate(() => autoHidden.slice()), P("Empty"));

    /* The user opts back in. */
    await app.page.evaluate((p) => setFolderVisible(p, true), P("Empty"));
    assert.includes(await app.page.evaluate(() => userTicked.slice()), P("Empty"));
    assert.eq((await app.hiddenPaths()).includes(P("Empty")), false);

    /* Full rescan must not undo that choice. */
    await app.rescan();
    await app.waitForScan(25000);

    hidden = await app.hiddenPaths();
    assert.eq(hidden.includes(P("Empty")), false, "the rescan auto-unticked a folder the user ticked back on");
    assert.includes(hidden, P("Documents"), "still-empty folders stay unticked");
  } finally { await app.close(); }
}, { timeout: 60000 });

test("26 · \"Only folders with photos\" hides empty branches but keeps the ones that matter", async () => {
  const drive = buildDrive([
    folder("Pics", [
      image("a.jpg", { taken: "2024-05-01T00:00:00Z" }),
      folder("Deep", [image("b.jpg", { taken: "2024-05-02T00:00:00Z" })]),
    ]),
    folder("Barren", [folder("BarrenSub", [file("x.txt")])]),
    folder("Marked", [nomedia(), image("m.jpg", { taken: "2024-05-03T00:00:00Z" })]),
    folder("UserHidden", [image("u.jpg", { taken: "2024-05-04T00:00:00Z" })]),
  ]);
  const app = await launchApp({ drive });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    /* hide one folder deliberately — that is different from auto-hidden */
    await app.expand(ROOT);
    await app.toggleFolder("UserHidden", false);
    await app.expand(ROOT, P("Pics"), P("Barren"));

    let names = (await app.folderRows()).map((r) => r.name);
    assert.includes(names, "Pics", "a folder with photos must stay");
    assert.includes(names, "Deep", "a photo-bearing descendant must stay");
    assert.ok(names.some((n) => n.startsWith("Marked")), "a .nomedia folder must stay listed");
    assert.includes(names, "UserHidden", "a folder YOU hid must stay listed so you can unhide it");
    assert.eq(names.includes("Barren"), false, "an empty branch should be hidden: " + JSON.stringify(names));
    assert.eq(names.includes("BarrenSub"), false);

    /* turning the switch off reveals them again */
    await app.page.click("#fldCog");
    await app.page.click("#withPhotosToggle");
    await app.page.waitForTimeout(150);
    await app.expand(ROOT, P("Barren"));
    names = (await app.folderRows()).map((r) => r.name);
    assert.includes(names, "Barren");
    assert.includes(names, "BarrenSub");
    assert.eq(await app.page.evaluate(() => lsGet("lumen_onlyphotos")), "0");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("27 · the chevron only appears when a folder has children visible under the current filter", async () => {
  const drive = buildDrive([
    folder("Mixed", [
      image("m1.jpg", { taken: "2024-05-01T00:00:00Z" }),
      folder("NoPics", [file("a.txt")]),
    ]),
  ]);
  const app = await launchApp({ drive });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    await app.expand(ROOT);

    let mixed = await app.folderRow("Mixed");
    assert.ok(mixed, "no Mixed row");
    assert.eq(mixed.chevron, false, "Mixed has no visible children, so it must not offer a chevron");
    const root = await app.folderRow("OneDrive");
    assert.eq(root.chevron, true, "the root does have a visible child");

    await app.page.click("#fldCog");
    await app.page.click("#withPhotosToggle");
    await app.page.waitForTimeout(150);
    mixed = await app.folderRow("Mixed");
    assert.eq(mixed.chevron, true, "with the filter off, NoPics is visible so Mixed gets a chevron");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("28 · scan progress is shown in the tree while the walk is running", async () => {
  const drive = twoBranchDrive();
  const slow = [drive.idOf("Alpha"), drive.idOf("Beta")];
  const app = await launchApp({
    drive,
    graph: (ctx) => {
      const m = ctx.path.match(/^\/v1\.0\/me\/drive\/items\/([^/]+)\/children$/);
      return m && slow.includes(m[1]) ? { delay: 3000, json: { value: drive.children(m[1]) } } : null;
    },
  });
  try {
    await app.goto();
    await app.openFolderPanel();

    /* Folders still to visit are marked as queued as soon as they are known. */
    await app.page.waitForFunction(() => document.querySelectorAll("#folderTreeEl .fld.queued").length >= 2,
      undefined, { timeout: 10000, polling: 50 });
    const status = await app.page.textContent("#fldStatus");
    assert.match(status, /Scanning now/);
    assert.match(status, /queued/);
    assert.match(await app.page.getAttribute("#fldStatus", "class"), /scanning/);

    /* Re-render mid-batch: the two folders being listed right now are busy. */
    await app.page.evaluate(() => renderFolderTree());
    const rows = await app.folderRows();
    const busy = rows.filter((r) => r.busy).map((r) => r.name);
    assert.gte(busy.length, 1, "no folder marked busy while it is being listed: " +
      JSON.stringify(rows.map((r) => [r.name, r.queued, r.busy])));

    await app.waitForScan(30000);
    const after = await app.folderRows();
    assert.eq(after.filter((r) => r.queued || r.busy).length, 0, "progress markers left behind after the scan");
  } finally { await app.close(); }
}, { timeout: 60000 });
