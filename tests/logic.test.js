"use strict";
/* Unit-level checks of the app's internal helpers. These run against a
   signed-out page (no scan, ~200ms) and call the globals directly, which is
   possible because index.html is a classic script: its top-level bindings
   live in the page's global lexical scope. */

const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");

/* A page with no account: boots to the setup screen and touches nothing. */
async function bare() {
  const app = await launchApp({ msal: { accounts: [] } });
  await app.goto();
  return app;
}

test("L1 · dateFromName reads a camera-style date out of the filename", async () => {
  const app = await bare();
  try {
    const got = await app.page.evaluate(() => ({
      compact: dateFromName("IMG_20230715_101010.jpg", 0).slice(0, 10),
      dashed: dateFromName("2022-12-31 party.jpg", 0).slice(0, 10),
      underscored: dateFromName("PXL_2021_03_04_x.jpg", 0).slice(0, 10),
      bogusMonth: dateFromName("2021-99-99.jpg", Date.parse("2019-05-06T00:00:00Z")).slice(0, 10),
      noDate: dateFromName("holiday.jpg", Date.parse("2018-02-03T12:00:00Z")).slice(0, 10),
      nothing: typeof dateFromName("x.jpg", undefined),
    }));
    assert.eq(got.compact, "2023-07-15");
    assert.eq(got.dashed, "2022-12-31");
    assert.eq(got.underscored, "2021-03-04");
    assert.eq(got.bogusMonth, "2019-05-06", "an impossible date must fall back to lastModified");
    assert.eq(got.noDate, "2018-02-03");
    assert.eq(got.nothing, "string", "a missing timestamp must still produce a date");
  } finally { await app.close(); }
});

test("L2 · path filters match a folder and its subtree, never a lookalike sibling", async () => {
  const app = await bare();
  try {
    const got = await app.page.evaluate(() => {
      hiddenPaths = ["/drive/root:/Pics"];
      excludedPaths = ["/drive/root:/Marked"];
      honorNomedia = true;
      return {
        self: isHidden("/drive/root:/Pics"),
        child: isHidden("/drive/root:/Pics/2024"),
        deep: isHidden("/drive/root:/Pics/2024/May"),
        sibling: isHidden("/drive/root:/Pics2"),
        prefixy: isHidden("/drive/root:/PicsOld/x"),
        parent: isHidden("/drive/root:"),
        none: isHidden(null),
        exclSelf: isExcluded("/drive/root:/Marked"),
        exclChild: isExcluded("/drive/root:/Marked/Sub"),
        exclSibling: isExcluded("/drive/root:/MarkedUp"),
        filtered: isFilteredOut("/drive/root:/Marked/Sub"),
      };
    });
    assert.eq(got.self, true);
    assert.eq(got.child, true);
    assert.eq(got.deep, true);
    assert.eq(got.sibling, false, "a folder sharing a name prefix must not be hidden");
    assert.eq(got.prefixy, false);
    assert.eq(got.parent, false, "hiding a child must not hide its parent");
    assert.eq(got.none, false);
    assert.eq(got.exclSelf, true);
    assert.eq(got.exclChild, true);
    assert.eq(got.exclSibling, false);
    assert.eq(got.filtered, true);
  } finally { await app.close(); }
});

test("L3 · the timeline groups by month and parks undated photos under \"Undated\"", async () => {
  const app = await bare();
  try {
    const got = await app.page.evaluate(() => {
      photos = [
        { id: "a", name: "a.jpg", date: "2024-05-02T00:00:00Z", size: 1, path: "/drive/root:" },
        { id: "b", name: "b.jpg", date: "2024-05-30T00:00:00Z", size: 2, path: "/drive/root:" },
        { id: "c", name: "c.jpg", date: "2023-01-09T00:00:00Z", size: 3, path: "/drive/root:" },
        { id: "d", name: "d.jpg", date: undefined, size: 4, path: "/drive/root:" },
      ];
      localPhotos = []; hiddenPaths = []; excludedPaths = [];
      buildRenderQueue();
      return {
        order: view.map((p) => p.name),
        queue: renderQueue.map((i) => (i.type === "month" ? "M:" + i.label : "P:" + i.p.name)),
        undated: monthLabel(undefined),
        nullDate: monthLabel(null),   // documented quirk, see tests/README.md
      };
    });
    assert.deepEq(got.order, ["b.jpg", "a.jpg", "c.jpg", "d.jpg"], "not sorted newest-first");
    assert.eq(got.undated, "Undated");
    /* Records today's behaviour: a literal null date is NOT "Undated" —
       new Date(null) is the epoch. Harmless today (Graph always sends
       lastModifiedDateTime) but noted in the report. */
    assert.match(got.nullDate, /1970/);
    /* one header per month, each immediately followed by its photos */
    assert.eq(got.queue[0].startsWith("M:"), true);
    assert.eq(got.queue.filter((x) => x.startsWith("M:")).length, 3, JSON.stringify(got.queue));
    assert.eq(got.queue[got.queue.length - 1], "P:d.jpg");
    assert.eq(got.queue[got.queue.length - 2], "M:Undated");
  } finally { await app.close(); }
});

test("L4 · buildView dedupes on name+size and lets the device copy win", async () => {
  const app = await bare();
  try {
    const got = await app.page.evaluate(() => {
      photos = [
        { id: "o1", name: "Same.JPG", date: "2024-01-01", size: 100, path: "/drive/root:", source: "onedrive" },
        { id: "o2", name: "other.jpg", date: "2024-01-02", size: 100, path: "/drive/root:", source: "onedrive" },
        { id: "o3", name: "nosize.jpg", date: "2024-01-03", size: null, path: "/drive/root:", source: "onedrive" },
      ];
      localPhotos = [
        { id: "l1", name: "same.jpg", date: "2024-01-01", size: 100, path: "device:", source: "local" },
        { id: "l2", name: "nosize.jpg", date: "2024-01-03", size: null, path: "device:", source: "local" },
      ];
      hiddenPaths = []; excludedPaths = [];
      buildView();
      return view.map((p) => [p.name, p.source]);
    });
    assert.eq(got.length, 3, "expected three distinct photos, got " + JSON.stringify(got));
    assert.eq(got.filter(([n]) => n.toLowerCase() === "same.jpg").length, 1,
      "case-insensitive name + size did not dedupe");
    assert.eq(got.find(([n]) => n.toLowerCase() === "same.jpg")[1], "local",
      "the device copy should win");
    assert.eq(got.find(([n]) => n === "nosize.jpg")[1], "local",
      "photos with an unknown size still dedupe by name");
  } finally { await app.close(); }
});

test("L5 · a hidden device folder lets the OneDrive copy of a duplicate show through", async () => {
  const app = await bare();
  try {
    const names = await app.page.evaluate(() => {
      photos = [{ id: "o1", name: "dupe.jpg", date: "2024-01-01", size: 7, path: "/drive/root:/Pics", source: "onedrive" }];
      localPhotos = [{ id: "l1", name: "dupe.jpg", date: "2024-01-01", size: 7, path: "device:/DCIM", source: "local" }];
      hiddenPaths = ["device:/DCIM"]; excludedPaths = [];
      buildView();
      return view.map((p) => p.source);
    });
    assert.deepEq(names, ["onedrive"],
      "hiding the device folder should reveal the OneDrive copy, not lose the photo");
  } finally { await app.close(); }
});

test("L6 · folder counts roll up, and orphaned folders are re-parented to the root", async () => {
  const app = await bare();
  try {
    const got = await app.page.evaluate(() => {
      folderTree = [
        { path: "/drive/root:/A", name: "A", parentPath: "/drive/root:" },
        { path: "/drive/root:/A/B", name: "B", parentPath: "/drive/root:/A" },
        { path: "/drive/root:/Lost/Deep", name: "Deep", parentPath: "/drive/root:/Lost" },
      ];
      photos = [
        { id: "1", name: "1.jpg", date: "2024-01-01", size: 1, path: "/drive/root:/A" },
        { id: "2", name: "2.jpg", date: "2024-01-01", size: 2, path: "/drive/root:/A/B" },
        { id: "3", name: "3.jpg", date: "2024-01-01", size: 3, path: "/drive/root:/A/B" },
        { id: "4", name: "4.jpg", date: "2024-01-01", size: 4, path: "/drive/root:/Lost/Deep" },
      ];
      const root = buildFolderIndex();
      const find = (n, p) => n.path === p ? n : n.kids.reduce((a, k) => a || find(k, p), null);
      return {
        rootTotal: root.total,
        a: find(root, "/drive/root:/A").total,
        b: find(root, "/drive/root:/A/B").total,
        orphanAttached: !!find(root, "/drive/root:/Lost/Deep"),
      };
    });
    assert.eq(got.b, 2);
    assert.eq(got.a, 3, "A should count its own photo plus B's two");
    assert.eq(got.rootTotal, 4);
    assert.eq(got.orphanAttached, true, "a folder whose parent is unknown must still appear");
  } finally { await app.close(); }
});

test("L7 · initials come from the display name, then the email, then a dot", async () => {
  const app = await bare();
  try {
    const got = await app.page.evaluate(() => [
      initialsOf("Ada Lovelace", "ada@example.com"),
      initialsOf("", "grace.hopper@example.com"),
      initialsOf("Cher", ""),
      initialsOf("", ""),
    ]);
    assert.deepEq(got, ["AL", "GH", "C", "·"]);
  } finally { await app.close(); }
});

test("L8 · setFolderVisible keeps hiddenPaths minimal (no redundant descendants)", async () => {
  const app = await bare();
  try {
    const got = await app.page.evaluate(() => {
      hiddenPaths = []; autoHidden = []; userTicked = []; photos = []; folderTree = [];
      setFolderVisible("/drive/root:/A/B", false);
      setFolderVisible("/drive/root:/A/C", false);
      const twoLeaves = hiddenPaths.slice();
      setFolderVisible("/drive/root:/A", false);      // swallows both leaves
      const collapsed = hiddenPaths.slice();
      setFolderVisible("/drive/root:/A", true);       // and releases the lot
      return { twoLeaves, collapsed, cleared: hiddenPaths.slice(), ticked: userTicked.slice() };
    });
    assert.eq(got.twoLeaves.length, 2);
    assert.deepEq(got.collapsed, ["/drive/root:/A"],
      "hiding a parent should replace, not accumulate, its hidden children");
    assert.deepEq(got.cleared, []);
    assert.includes(got.ticked, "/drive/root:/A", "the deliberate tick is not remembered");
  } finally { await app.close(); }
});
