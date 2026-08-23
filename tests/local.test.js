"use strict";
/* Photos read from the device: they join the same timeline, dedupe against
   the OneDrive copy, carry their own badge, and get their own folder tree.
   Fake File objects are handed straight to addLocalFiles() — driving a real
   file picker adds nothing but flakiness. */

const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");
const { buildDrive, folder, image } = require("./lib/fixtures");
const { PNG } = require("./lib/png");

const B64 = PNG.toString("base64");
const SIZE = PNG.length;

/* Adds device photos through the app's own entry point. `files` is a list of
   { name, rel } — every file gets identical PNG bytes, so size is constant. */
function addLocal(app, files) {
  return app.page.evaluate(({ b64, files }) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const items = files.map((f) => ({
      file: new File([bytes], f.name, { type: "image/png", lastModified: Date.parse(f.modified || "2024-08-01T00:00:00Z") }),
      rel: f.rel || f.name,
    }));
    return addLocalFiles(items);
  }, { b64: B64, files });
}

test("29 · device photos get source \"local\" and land in the timeline", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    assert.eq(await app.cellCount(), 5);

    const added = await addLocal(app, [
      { name: "IMG_20230715_101010.png", rel: "DCIM/Camera/IMG_20230715_101010.png" },
      { name: "selfie.png", rel: "DCIM/Camera/selfie.png", modified: "2024-09-09T00:00:00Z" },
    ]);
    assert.eq(added, 2, "addLocalFiles should report two additions");
    await app.page.waitForTimeout(200);

    assert.eq(await app.cellCount(), 7, "device photos not in the grid");
    const sources = await app.page.evaluate(() => view.map((p) => [p.name, p.source]));
    const local = sources.filter(([, s]) => s === "local").map(([n]) => n).sort();
    assert.deepEq(local, ["IMG_20230715_101010.png", "selfie.png"]);
    assert.match(await app.countText(), /^7 photos$/);

    /* The date is read out of the camera-style filename. */
    const d = await app.page.evaluate(() =>
      localPhotos.find((p) => p.name.startsWith("IMG_2023")).date);
    assert.match(d, /^2023-07-1[45]/, "capture date not parsed from the filename");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("29b · non-images in a device selection are ignored", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    const added = await app.page.evaluate(() => addLocalFiles([
      new File(["x"], "notes.txt", { type: "text/plain" }),
      new File(["x"], "movie.mp4", { type: "video/mp4" }),
    ]));
    assert.eq(added, 0, "non-images were accepted");
    assert.eq(await app.cellCount(), 5);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("30 · a photo present both on the device and in OneDrive appears exactly once", async () => {
  /* Same name, same size on both sides — the dedupe key. */
  const drive = buildDrive([
    image("dupe.png", { taken: "2024-05-05T00:00:00Z", size: SIZE, mimeType: "image/png" }),
    image("cloud-only.png", { taken: "2024-05-06T00:00:00Z", size: 4242, mimeType: "image/png" }),
  ]);
  const app = await launchApp({ drive });
  try {
    await app.goto();
    await app.waitForScan();
    assert.eq(await app.cellCount(), 2);

    await addLocal(app, [
      { name: "dupe.png", rel: "DCIM/dupe.png" },
      { name: "phone-only.png", rel: "DCIM/phone-only.png" },
    ]);
    await app.page.waitForTimeout(200);

    const names = (await app.viewNames()).sort();
    assert.deepEq(names, ["cloud-only.png", "dupe.png", "phone-only.png"],
      "duplicate not collapsed");
    assert.eq(names.filter((n) => n === "dupe.png").length, 1);
    assert.eq(await app.cellCount(), 3);

    /* The device copy wins, so it renders from the local blob, not the network. */
    const src = await app.page.evaluate(() => view.find((p) => p.name === "dupe.png").source);
    assert.eq(src, "local", "the device copy should win a duplicate");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("31 · OneDrive photos show the cloud badge, device photos the phone badge", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await addLocal(app, [{ name: "onphone.png", rel: "DCIM/onphone.png", modified: "2030-01-01T00:00:00Z" }]);
    await app.page.waitForTimeout(200);

    const badges = await app.page.evaluate(() => {
      /* Compare the rendered path against the app's own icon constants, so
         the test stays honest if the artwork changes. */
      const dOf = (s) => (s.match(/ d="([^"]+)"/) || [])[1];
      const CLOUD = dOf(ICON_CLOUD), PHONE = dOf(ICON_PHONE);
      return [...document.querySelectorAll(".cell")].map((c) => {
        const b = c.querySelector(".src");
        const d = b.querySelector("svg path").getAttribute("d");
        return { kind: d === PHONE ? "local" : d === CLOUD ? "onedrive" : "?", title: b.title };
      });
    });
    const sources = await app.page.evaluate(() => view.map((p) => p.source));
    assert.eq(badges.length, sources.length, "one badge per cell");
    assert.deepEq(badges.map((b) => b.kind), sources, "badge does not match the photo's source");
    assert.eq(badges.filter((b) => b.kind === "local").length, 1);
    assert.eq(badges.filter((b) => b.kind === "onedrive").length, 5);
    assert.includes(badges.find((b) => b.kind === "local").title, "device");
    assert.includes(badges.find((b) => b.kind === "onedrive").title, "OneDrive");
    /* the badges really are inline svg, not glyphs */
    assert.eq(await app.page.locator(".cell .src svg").count(), 6);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("32 · the device tree renders beside the OneDrive tree and its folders can be hidden", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await addLocal(app, [
      { name: "a.png", rel: "DCIM/Camera/a.png" },
      { name: "b.png", rel: "DCIM/Screenshots/b.png" },
    ]);
    await app.page.waitForTimeout(150);

    await app.openFolderPanel();
    await app.expand("/drive/root:", "device:", "device:/DCIM");
    const rows = await app.folderRows();
    const names = rows.map((r) => r.name);
    assert.includes(names, "OneDrive", "the OneDrive tree is missing");
    assert.includes(names, "This device", "the device tree is missing");
    assert.includes(names, "DCIM");
    assert.includes(names, "Camera");
    assert.includes(names, "Screenshots");
    const dev = rows.find((r) => r.name === "This device");
    assert.eq(dev.count, "2", "device root should roll up both photos");
    assert.eq(dev.root, true);

    /* Hiding a device folder drops just its photos. */
    await app.toggleFolder("Camera", false);
    await app.page.waitForTimeout(150);
    const names2 = await app.viewNames();
    assert.eq(names2.includes("a.png"), false, "hidden device folder still showing");
    assert.includes(names2, "b.png");
    assert.eq(await app.cellCount(), 6);
    assert.includes(await app.hiddenPaths(), "device:/DCIM/Camera");
  } finally { await app.close(); }
}, { timeout: 40000 });
