"use strict";
/* Delete and Move from the lightbox, and the metadata shown alongside them.
   These are the only paths in the app that write to OneDrive. */

const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");

const ROOT = "/drive/root:";

/* Open the lightbox on the first cell. */
async function openFirst(app) {
  await app.page.click(".cell");
  await app.page.waitForFunction(
    () => getComputedStyle(document.getElementById("lightbox")).display === "flex",
    undefined, { timeout: 5000 });
}
const sheetOpen = (app) =>
  app.page.waitForFunction(() => document.getElementById("sheet").classList.contains("open"),
    undefined, { timeout: 5000 });

test("44 · the lightbox shows size, date and OneDrive path next to the name", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await openFirst(app);

    const name = await app.page.textContent("#lbName");
    assert.ok(name && name.endsWith(".jpg"), "no file name: " + name);
    const sub = await app.page.textContent("#lbSub");
    assert.match(sub, /\d/, "metadata line has no size or date: " + sub);
    assert.match(sub, /B|KB|MB/, "no human-readable size: " + sub);
    const path = await app.page.textContent("#lbPath");
    assert.match(path, /^OneDrive/, "path should be shown human-readably: " + path);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("45 · Delete asks first, and cancelling writes nothing", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    const before = await app.cellCount();
    await openFirst(app);

    await app.page.click("#lbDelete");
    await sheetOpen(app);
    assert.match(await app.page.textContent("#sheetTitle"), /delete/i);
    assert.match(await app.page.textContent("#sheetBody"), /recycle bin/i,
      "the confirm should say the photo is recoverable");

    await app.page.click("#sheetCancel");
    await app.page.waitForTimeout(200);
    assert.deepEq(app.graph().filter((r) => r.method === "DELETE"), [],
      "cancelling still sent a DELETE");
    assert.eq(await app.cellCount(), before, "cancelling removed the photo anyway");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("46 · confirming Delete issues one DELETE and drops the photo", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    const before = await app.viewNames();
    await openFirst(app);
    const target = await app.page.textContent("#lbName");

    await app.page.click("#lbDelete");
    await sheetOpen(app);
    await app.page.click("#sheetOk");
    await app.page.waitForFunction((n) => !view.some((p) => p.name === n), target,
      { timeout: 8000, polling: 50 });

    const dels = app.graph().filter((r) => r.method === "DELETE");
    assert.eq(dels.length, 1, "expected exactly one DELETE");
    assert.match(dels[0].url, /\/me\/drive\/items\//);
    const after = await app.viewNames();
    assert.eq(after.length, before.length - 1, "timeline count did not drop");
    assert.eq(after.includes(target), false, "the deleted photo is still listed");
    assert.eq(await app.page.evaluate((n) => photos.some((p) => p.name === n), target), false,
      "the deleted photo is still in the underlying list");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("46b · a deleted photo stays gone after a reload (cache was updated)", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await openFirst(app);
    const target = await app.page.textContent("#lbName");
    await app.page.click("#lbDelete");
    await sheetOpen(app);
    await app.page.click("#sheetOk");
    await app.page.waitForFunction((n) => !view.some((p) => p.name === n), target,
      { timeout: 8000, polling: 50 });
    await app.page.waitForTimeout(400);   // let persistCache land

    await app.reload();
    await app.waitForScan();
    assert.eq((await app.viewNames()).includes(target), false,
      "the deleted photo came back from the cache");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("47 · Move offers the known folders and PATCHes the item to the chosen one", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await openFirst(app);
    const target = await app.page.textContent("#lbName");

    await app.page.click("#lbMove");
    await sheetOpen(app);
    const options = await app.page.$$eval("#sheetPick .fld .nm", (els) => els.map((e) => e.textContent));
    assert.gte(options.length, 2, "the picker listed nothing: " + JSON.stringify(options));
    assert.ok(options.some((o) => /Documents/.test(o)), "known folders missing: " + JSON.stringify(options));

    /* Confirm is disabled until a destination is chosen. */
    assert.eq(await app.page.isDisabled("#sheetOk"), true, "Move was enabled with nothing selected");
    const idx = options.findIndex((o) => /Documents/.test(o));
    await app.page.click(`#sheetPick .fld:nth-child(${idx + 1})`);
    assert.eq(await app.page.isDisabled("#sheetOk"), false);
    await app.page.click("#sheetOk");

    await app.page.waitForFunction(
      (n) => (view.find((p) => p.name === n) || {}).path === "/drive/root:/Documents",
      target, { timeout: 8000, polling: 50 });

    const patches = app.graph().filter((r) => r.method === "PATCH");
    assert.eq(patches.length, 1, "expected exactly one PATCH");
    assert.match(patches[0].url, /\/me\/drive\/items\//);
    const body = JSON.parse(patches[0].postData || "{}");
    assert.ok(body.parentReference && body.parentReference.id,
      "PATCH must carry parentReference.id: " + patches[0].postData);
    /* Documents was empty, so it had been auto-unticked. Moving a photo in
       must not make that photo disappear. */
    assert.includes(await app.viewNames(), target, "the moved photo vanished from the timeline");
    assert.eq((await app.hiddenPaths()).includes("/drive/root:/Documents"), false,
      "the destination should have been un-hidden when a photo was moved into it");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("48 · device photos offer neither Delete nor Move", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.evaluate(() => {
      const f = new File([new Uint8Array([1, 2, 3])], "phone-only.jpg", { type: "image/jpeg" });
      Object.defineProperty(f, "webkitRelativePath", { value: "DCIM/Camera/phone-only.jpg" });
      addLocalFiles([f]);
    });
    await app.page.waitForFunction(() => view.some((p) => p.source === "local"),
      undefined, { timeout: 5000 });
    await app.page.evaluate(() => openLightbox(view.find((p) => p.source === "local")));
    await app.page.waitForTimeout(150);

    assert.eq(await app.page.isVisible("#lbDelete"), false, "Delete offered for a device photo");
    assert.eq(await app.page.isVisible("#lbMove"), false, "Move offered for a device photo");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("50 · write access is only asked for when you actually delete something", async () => {
  /* Signed in with read scopes only: a silent request for Files.ReadWrite
     fails until the user consents interactively. */
  const app = await launchApp({
    drive: demoDrive(),
    msal: { consented: ["Files.Read", "User.Read"] },
  });
  try {
    await app.goto();
    await app.waitForScan();

    const askedFor = async () => (await app.msalCalls())
      .filter((c) => c.scopes && c.scopes.includes("Files.ReadWrite"));
    assert.deepEq(await askedFor(), [], "write scope was requested just to browse");

    await openFirst(app);
    await app.page.click("#lbDelete");
    await sheetOpen(app);
    /* The sheet warns that a permission prompt is coming. */
    assert.match(await app.page.textContent("#sheetBody"), /read-only|allow changes/i);
    await app.page.click("#sheetOk");
    await app.page.waitForTimeout(900);

    const calls = await askedFor();
    assert.gte(calls.length, 1, "no write-scope token was ever requested");
    assert.ok(calls.some((c) => c.m === "acquireTokenPopup"),
      "consent should be collected in a popup, keeping the page alive: " +
      JSON.stringify(calls.map((c) => c.m)));
    assert.eq(app.graph().filter((r) => r.method === "DELETE").length, 1,
      "the delete should go through once consent is granted");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("50b · a refused consent popup leaves the photo alone", async () => {
  const app = await launchApp({
    drive: demoDrive(),
    msal: { consented: ["Files.Read", "User.Read"], popupFails: true },
  });
  try {
    await app.goto();
    await app.waitForScan();
    const before = await app.viewNames();
    await openFirst(app);
    await app.page.click("#lbDelete");
    await sheetOpen(app);
    await app.page.click("#sheetOk");
    await app.page.waitForTimeout(800);

    assert.deepEq(app.graph().filter((r) => r.method === "DELETE"), [],
      "a delete was sent without write consent");
    assert.deepEq(await app.viewNames(), before, "the photo vanished despite no consent");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("49 · a failed delete leaves the photo in place and says so", async () => {
  const app = await launchApp({
    drive: demoDrive(),
    graph: (ctx) => ctx.method === "DELETE"
      ? { status: 403, json: { error: { code: "accessDenied", message: "nope" } } } : null,
  });
  try {
    await app.goto();
    await app.waitForScan();
    const before = await app.viewNames();
    await openFirst(app);
    await app.page.click("#lbDelete");
    await sheetOpen(app);
    await app.page.click("#sheetOk");
    await app.page.waitForFunction(
      () => getComputedStyle(document.getElementById("toast")).display !== "none",
      undefined, { timeout: 8000, polling: 50 });

    assert.match(await app.page.textContent("#toast"), /couldn't delete/i);
    assert.deepEq(await app.viewNames(), before, "a failed delete still removed the photo");
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });
