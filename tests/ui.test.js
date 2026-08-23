"use strict";
/* Lightbox, Back-button handling, the hamburger menu, the Folders cog and
   the icon set. */

const fs = require("fs");
const path = require("path");
const { test, assert } = require("./lib/tiny");
const { launchApp } = require("./lib/harness");
const { demoDrive } = require("./lib/drives");

const INDEX = path.resolve(__dirname, "..", "index.html");

const lbOpen = (app) => app.page.evaluate(() =>
  getComputedStyle(document.getElementById("lightbox")).display === "flex");

test("33 · clicking a cell opens the lightbox and Back closes it (without leaving)", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    const url = app.page.url();
    const depth = await app.page.evaluate(() => history.length);

    await app.page.click(".cell");
    await app.page.waitForFunction(() =>
      getComputedStyle(document.getElementById("lightbox")).display === "flex",
      undefined, { timeout: 5000 });
    assert.eq(await app.page.evaluate(() => lbIndex), 0, "lightbox opened on the wrong photo");
    assert.eq(await app.page.textContent("#lbName"), (await app.viewNames())[0]);
    assert.gte(await app.page.evaluate(() => history.length), depth + 1,
      "no history entry was pushed for the open photo");

    /* The system Back button. */
    await app.page.evaluate(() => history.back());
    await app.page.waitForFunction(() =>
      getComputedStyle(document.getElementById("lightbox")).display === "none",
      undefined, { timeout: 5000 });
    assert.eq(app.page.url(), url, "Back left the page instead of closing the photo");
    assert.eq(await app.visible("gallery"), true, "the gallery is gone after Back");
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("33b · the ✕ button closes the lightbox and keeps the history stack balanced", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    const cycle = async () => {
      await app.page.click(".cell");
      await app.page.waitForFunction(() =>
        getComputedStyle(document.getElementById("lightbox")).display === "flex", undefined, { timeout: 5000 });
      await app.page.click("#lbClose");
      await app.page.waitForFunction(() =>
        getComputedStyle(document.getElementById("lightbox")).display === "none", undefined, { timeout: 5000 });
      return app.page.evaluate(() => history.length);
    };

    const first = await cycle();
    assert.eq(await cycle(), first, "the history stack grew on the second open/close");
    assert.eq(await cycle(), first, "the history stack grew on the third open/close");
    assert.eq(await app.page.evaluate(() => lbHistory), false, "lbHistory left set after closing");
    assert.eq(await app.page.evaluate(() => !!(history.state && history.state.lumenLb)), false,
      "the lightbox history entry is still current after closing");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("33c · lightbox arrows step through the timeline", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    const names = await app.viewNames();
    await app.page.click(".cell");
    await app.page.waitForFunction(() =>
      getComputedStyle(document.getElementById("lightbox")).display === "flex", undefined, { timeout: 5000 });
    await app.page.click("#lbNext");
    assert.eq(await app.page.textContent("#lbName"), names[1]);
    await app.page.click("#lbPrev");
    assert.eq(await app.page.textContent("#lbName"), names[0]);
    /* wrap-around, not a crash */
    await app.page.click("#lbPrev");
    assert.eq(await app.page.textContent("#lbName"), names[names.length - 1]);
    assert.deepEq(app.pageErrors, []);
  } finally { await app.close(); }
}, { timeout: 40000 });

test("34 · double-back-to-exit is armed only in standalone display mode", async () => {
  /* Installed PWA: the guard entry is pushed and the first Back warns. */
  const pwa = await launchApp({ drive: demoDrive(), standalone: true });
  try {
    await pwa.goto();
    await pwa.waitForScan();
    assert.eq(await pwa.page.evaluate(() => isStandalone()), true, "standalone stub not in effect");
    assert.eq(await pwa.page.evaluate(() => guardPushed), true, "no back-guard in a standalone window");

    await pwa.page.evaluate(() => history.back());
    await pwa.page.waitForFunction(() =>
      getComputedStyle(document.getElementById("toast")).display !== "none",
      undefined, { timeout: 5000 });
    assert.match(await pwa.page.textContent("#toast"), /back again to exit/i);
    assert.eq(await pwa.page.evaluate(() => backArmed), true);
    assert.eq(await pwa.visible("gallery"), true, "the first Back must not leave the app");
  } finally { await pwa.close(); }

  /* Ordinary browser tab: Back is not trapped at all. */
  const tab = await launchApp({ drive: demoDrive() });
  try {
    await tab.goto();
    await tab.waitForScan();
    assert.eq(await tab.page.evaluate(() => isStandalone()), false);
    assert.eq(await tab.page.evaluate(() => guardPushed), false, "a browser tab must not trap Back");

    /* Push an entry of our own and go back: the handler must stay out of it. */
    await tab.page.evaluate(() => history.pushState({ mine: true }, ""));
    await tab.page.evaluate(() => history.back());
    await tab.page.waitForTimeout(400);
    assert.eq(await tab.visible("toast"), false, "the exit warning fired in a normal tab");
    assert.eq(await tab.page.evaluate(() => backArmed), false);
  } finally { await tab.close(); }
}, { timeout: 60000 });

test("35 · the hamburger menu opens, closes, and shows the signed-in account", async () => {
  const app = await launchApp({
    drive: demoDrive(),
    me: { displayName: "Graph Person", mail: "graph.person@example.com" },
  });
  try {
    await app.goto();
    await app.waitForScan();

    assert.eq(await app.page.evaluate(() => document.getElementById("menu").classList.contains("open")), false);
    await app.page.click("#menuBtn");
    await app.page.waitForSelector("#menu.open");
    assert.eq(await app.page.getAttribute("#menuBtn", "aria-expanded"), "true");

    const items = await app.page.$$eval("#menu .menu-item", (els) => els.map((e) => e.textContent.trim()));
    assert.deepEq(items, ["Folders", "Diagnostics", "Sign out"]);

    /* Name and email come from the stubbed /me, not just from MSAL. */
    await app.page.waitForFunction(() =>
      document.getElementById("acctName").textContent === "Graph Person",
      undefined, { timeout: 5000, polling: 50 });
    assert.eq(await app.page.textContent("#acctMail"), "graph.person@example.com");
    assert.eq(await app.page.textContent("#avatarIni"), "GP", "initials not derived from the name");

    await app.page.click("#menuBackdrop");
    await app.page.waitForSelector("#menu.open", { state: "detached" }).catch(() => {});
    assert.eq(await app.page.evaluate(() => document.getElementById("menu").classList.contains("open")), false,
      "the backdrop did not close the menu");
    assert.eq(await app.page.getAttribute("#menuBtn", "aria-expanded"), "false");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("35b · the menu opens the Folders and Diagnostics panels", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.page.click("#menuBtn");
    await app.page.click("#menuFolders");
    await app.page.waitForSelector("#folders.open");
    assert.eq(await app.page.evaluate(() => document.getElementById("menu").classList.contains("open")), false,
      "the menu should close behind the panel it opened");
    await app.page.click("#foldersClose");
    await app.page.waitForSelector("#folders.open", { state: "detached" }).catch(() => {});

    await app.page.click("#menuBtn");
    await app.page.click("#menuDiag");
    await app.page.waitForSelector("#diag.open");
    await app.page.click("#diagClose");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("36 · the Folders cog opens a dropdown with both switches; the backdrop closes it", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();

    assert.eq(await app.visible("fldConfig"), false, "the dropdown starts closed");
    await app.page.click("#fldCog");
    await app.page.waitForSelector("#fldConfig.open");
    assert.eq(await app.page.getAttribute("#fldCog", "aria-expanded"), "true");

    const labels = await app.page.$$eval("#fldConfig .fld-toggle .lbl", (els) => els.map((e) => e.textContent.trim()));
    assert.eq(labels.length, 2, "expected exactly two switches");
    assert.match(labels[0], /Only folders with photos/);
    assert.match(labels[1], /\.nomedia/);
    assert.eq(await app.page.locator("#fldConfig input[type=checkbox]").count(), 2);

    await app.page.click("#fldBackdrop");
    await app.page.waitForTimeout(150);
    assert.eq(await app.page.evaluate(() => document.getElementById("fldConfig").classList.contains("open")), false,
      "the backdrop did not close the cog dropdown");
    assert.eq(await app.page.getAttribute("#fldCog", "aria-expanded"), "false");
    assert.eq(await app.page.evaluate(() => document.getElementById("folders").classList.contains("open")), true,
      "closing the dropdown must not close the Folders panel");
  } finally { await app.close(); }
}, { timeout: 40000 });

test("37 · Rescan lives in the Folders panel header and triggers a full rescan", async () => {
  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();
    await app.openFolderPanel();
    assert.eq(await app.page.locator("#folders .diag-bar #fldRescan").count(), 1,
      "the rescan button is not in the Folders panel header");

    app.clearRequests();
    await app.page.click("#fldRescan");
    await app.waitForScanStart();
    assert.eq(await app.page.evaluate(() => document.getElementById("folders").classList.contains("open")), false,
      "rescan should close the panel so you can watch it run");
    const text = await app.waitForScan(25000);
    assert.gte(app.graph(/children/).length, 3, "no folder walk after Rescan");
    assert.match(text, /Scan complete/);
    assert.eq((await app.viewNames()).length, 5);
  } finally { await app.close(); }
}, { timeout: 60000 });

test("38 · the chrome uses inline SVG, not rare glyphs that Android fonts lack", async () => {
  /* U+23FB power, U+21BB / U+27F3 refresh, U+2699 gear, U+2630 hamburger,
     U+2B07 / U+2913 download — all commonly missing from Android fonts.
     (The source may still mention them in a comment; what matters is that
     none of them is ever rendered.) */
  const banned = ["⏻", "⏼", "⏾", "↻", "⟳", "⚙", "☰", "⬇", "⤓", "↺"];

  const app = await launchApp({ drive: demoDrive() });
  try {
    await app.goto();
    await app.waitForScan();

    const rendered = await app.page.evaluate(() => {
      /* every bit of text the user can actually see, panels included —
         but not the script/style source, which may name a glyph to say it
         is deliberately NOT used */
      const clone = document.body.cloneNode(true);
      for (const el of clone.querySelectorAll("script,style")) el.remove();
      const texts = [clone.textContent];
      for (const el of document.querySelectorAll("[title],[aria-label],[placeholder]")) {
        texts.push(el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("placeholder"));
      }
      return texts.filter(Boolean).join(" ");
    });
    const found = banned.filter((ch) => rendered.includes(ch));
    assert.deepEq(found.map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()), [],
      "rare glyphs rendered in the UI");
    const needSvg = {
      "#menuSignout": "power / sign out",
      "#fldRescan": "refresh",
      "#installBtn": "install",
      "#installBtn2": "install (topbar)",
      "#menuBtn": "hamburger",
      "#fldCog": "cog",
      "#diagClose": "close",
    };
    for (const [sel, what] of Object.entries(needSvg)) {
      assert.eq(await app.page.locator(sel + " svg").count(), 1, `${what} (${sel}) should be an inline <svg>`);
    }
    /* and the icon really draws something */
    const d = await app.page.getAttribute("#fldRescan svg path", "d");
    assert.ok(d && d.length > 5, "the refresh icon has no path data");
  } finally { await app.close(); }
}, { timeout: 40000 });
