"use strict";
/* The recursive drive walk: what it finds, what it ignores, how it paces
   itself, how it recovers, and how it reports progress. */

const { test, assert } = require("./lib/tiny");
const { launchApp, GRAPH } = require("./lib/harness");
const { demoDrive, twoBranchDrive } = require("./lib/drives");
const { buildDrive, folder, image, file } = require("./lib/fixtures");

test("5 · recursive walk finds images in nested folders", async () => {
  const drive = demoDrive();
  const app = await launchApp({ drive });
  try {
    await app.goto();
    await app.waitForScan();
    const names = (await app.viewNames()).sort();
    assert.deepEq(names, ["c1.jpg", "c2.jpg", "p1.jpg", "p2.jpg", "root-jun.jpg"]);
    assert.eq(names.length, drive.imageCount, "photo count vs fixture");
    assert.eq(await app.cellCount(), 5, "cells in the DOM");
    assert.match(await app.countText(), /^5 photos$/);
  } finally { await app.close(); }
});

test("5b · deep nesting (5 levels) is walked to the bottom", async () => {
  const drive = buildDrive([
    folder("L1", [folder("L2", [folder("L3", [folder("L4", [
      image("deep.jpg", { taken: "2024-01-01T00:00:00Z" }),
    ])])])]),
  ]);
  const app = await launchApp({ drive });
  try {
    await app.goto();
    await app.waitForScan();
    assert.deepEq(await app.viewNames(), ["deep.jpg"]);
  } finally { await app.close(); }
});

test("5c · folder paging ($top / nextLink) is followed", async () => {
  /* The first three list requests use $top=40, so 45 children need two pages. */
  const kids = [];
  for (let i = 0; i < 45; i++) kids.push(image(`bulk${i}.jpg`, { taken: "2024-02-01T00:00:00Z" }));
  const drive = buildDrive([folder("Bulk", kids)]);
  const app = await launchApp({ drive });
  try {
    await app.goto();
    await app.waitForScan();
    assert.eq((await app.viewNames()).length, 45, "all paged children collected");
    assert.gte(app.graph(/skiptoken=/).length, 1, "nextLink was followed");
  } finally { await app.close(); }
});

test("6 · non-image files are ignored and images without a thumbnail are skipped", async () => {
  const drive = buildDrive([
    image("ok.jpg", { taken: "2024-06-01T00:00:00Z" }),
    image("nothumb.jpg", { taken: "2024-06-02T00:00:00Z", noThumb: true }),
    file("doc.pdf", "application/pdf"),
    file("clip.mp4", "video/mp4"),
    file("note.txt", "text/plain"),
  ]);
  const app = await launchApp({ drive });
  try {
    await app.goto();
    await app.waitForScan();
    assert.deepEq(await app.viewNames(), ["ok.jpg"]);
    assert.eq(await app.cellCount(), 1);
  } finally { await app.close(); }
});

test("7 · photos render progressively, before the scan finishes", async () => {
  const drive = demoDrive();
  const slowId = drive.idOf("Camera Roll");
  const app = await launchApp({
    drive,
    graph: (ctx) => ctx.path === `/v1.0/me/drive/items/${slowId}/children`
      ? { delay: 5000, json: { value: drive.children(slowId) } }
      : null,
  });
  try {
    await app.goto();
    /* Cells for the folders already read must appear while the last folder
       is still in flight. */
    await app.page.waitForFunction(() => document.querySelectorAll(".cell").length > 0,
      undefined, { timeout: 4500, polling: 50 });
    const mid = await app.cellCount();
    assert.gte(mid, 3, "cells rendered mid-scan");
    assert.eq(await app.page.evaluate(() => scanning), true, "scan already finished — test is not proving anything");
    assert.match(await app.scanText(), /Scanning…/);

    await app.waitForScan(15000);
    assert.eq(await app.cellCount(), 5, "all cells after the scan");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("8 · the timeline is newest-first and grouped under month headers", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();

    const dates = await app.page.evaluate(() => view.map((p) => p.date));
    const ms = dates.map((d) => +new Date(d));
    for (let i = 1; i < ms.length; i++) assert.gte(ms[i - 1], ms[i], "timeline not newest-first");

    const months = await app.monthHeaders();
    assert.eq(months.length, 5, "one header per distinct month: " + JSON.stringify(months));
    assert.match(months[0], /2025/, "first header should be the newest month");
    assert.match(months[months.length - 1], /2022/, "last header should be the oldest month");

    /* Each header must be followed by a grid of that month's photos. */
    const layout = await app.page.$$eval("#stream > *", (els) =>
      els.map((e) => (e.classList.contains("month") ? "month:" + e.textContent : "grid:" + e.children.length)));
    assert.eq(layout[0].startsWith("month:"), true, "stream must open with a month header");
    assert.eq(layout.filter((l) => l.startsWith("grid:")).length, 5, "one grid per month");
  } finally { await app.close(); }
});

test("9 · a 429 with Retry-After is retried and the scan still completes", async () => {
  const drive = demoDrive();
  const picId = drive.idOf("Pictures");
  let throttled = 0;
  const app = await launchApp({
    drive,
    graph: (ctx) => {
      if (ctx.path === `/v1.0/me/drive/items/${picId}/children` && throttled === 0) {
        throttled++;
        return { status: 429, headers: { "Retry-After": "1" }, json: { error: { code: "activityLimitReached" } } };
      }
      return null;
    },
  });
  try {
    await app.goto();
    const text = await app.waitForScan(25000);
    assert.eq(throttled, 1, "the 429 was never served");
    assert.match(text, /Scan complete/, "scan did not complete after the throttle");
    assert.eq((await app.viewNames()).length, 5, "photos lost to the retry");
    const retries = app.graph(new RegExp(`items/${picId}/children`)).length;
    assert.eq(retries, 2, "the throttled folder should be requested exactly twice");
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("9b · Graph requests are paced, not fired all at once", async () => {
  /* Eight sibling folders would go out in one burst without the app's
     global REQ_GAP pacing. */
  const kids = [];
  for (let i = 0; i < 8; i++) kids.push(folder("F" + i, [image(`f${i}.jpg`, { taken: "2024-01-0" + (i + 1) + "T00:00:00Z" })]));
  const app = await launchApp({ drive: buildDrive(kids) });
  try {
    await app.goto();
    await app.waitForScan(25000);

    const ts = app.graph().filter((r) => !/photo\/\$value/.test(r.url)).map((r) => r.t);
    assert.gte(ts.length, 10, "not enough Graph requests to judge pacing");
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    const tooFast = gaps.filter((g) => g < 100).length;
    assert.lte(tooFast, 1, `requests were not paced: gaps=${JSON.stringify(gaps)}`);
    const span = ts[ts.length - 1] - ts[0];
    assert.gte(span, (ts.length - 1) * 100, "total span too short for the configured pacing");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("10 · completion is announced in the scan bar and the folder panel", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    const text = await app.waitForScan();
    assert.match(text, /^Scan complete · 5 photos in \d+ folders$/);

    await app.openFolderPanel();
    const status = await app.page.textContent("#fldStatus");
    assert.match(status, /Full scan finished/);
    assert.match(status, /folders/);
    assert.notMatch(status, /No full scan has finished yet/);
    const cls = await app.page.getAttribute("#fldStatus", "class");
    assert.notMatch(cls, /warn|scanning/);
  } finally { await app.close(); }
});

test("10b · the scan bar hides itself a few seconds after completion", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    assert.eq(await app.page.evaluate(() => document.getElementById("scanText").classList.contains("on")), true,
      "the status should still be up right after completion");
    await app.page.waitForFunction(
      () => !document.getElementById("scanText").classList.contains("on"),
      undefined, { timeout: 6000, polling: 100 });
  } finally { await app.close(); }
}, { timeout: 30000 });

test("11 · an interrupted scan checkpoints and the next launch resumes from it", async () => {
  const drive = twoBranchDrive();
  const betaId = drive.idOf("Beta");
  const state = { failBeta: true };
  const app = await launchApp({
    drive,
    graph: (ctx) => (state.failBeta && ctx.path === `/v1.0/me/drive/items/${betaId}/children`)
      ? { status: 500, json: { error: { code: "generalException" } } }
      : null,
  });
  try {
    await app.goto();
    await app.waitForScan(25000);

    const ck = await app.page.evaluate(() => idbGet(cacheKey + ":scan"));
    assert.ok(ck && ck.frontier && ck.frontier.length, "no resume checkpoint was written");
    assert.eq(ck.frontier.length, 2, "checkpoint should hold the two unfinished branches");

    /* Second launch: the failure is gone; the walk must pick up mid-tree. */
    state.failBeta = false;
    app.clearRequests();
    await app.reload();
    await app.page.waitForFunction(
      () => /Resuming scan/.test(document.getElementById("scanText").textContent || ""),
      undefined, { timeout: 15000, polling: 50 });
    await app.waitForScan(25000);

    assert.deepEq(app.graph(/\/me\/drive\/root\/children/), [],
      "the resumed scan re-listed the root instead of resuming");
    assert.eq((await app.viewNames()).sort().join(","), "a1.jpg,a2.jpg,b1.jpg,b2.jpg");

    const after = await app.page.evaluate(() => idbGet(cacheKey + ":scan"));
    assert.eq(after, null, "the checkpoint should be cleared once the walk finishes");
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 60000 });
