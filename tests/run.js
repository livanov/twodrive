#!/usr/bin/env node
"use strict";
/* Lumen test runner.
 *
 *   npm test                     run everything
 *   node tests/run.js ui folders run only test files whose name matches
 *   node tests/run.js --grep=429 run only tests whose name matches
 *   node tests/run.js --jobs=1   run test files one at a time (easier debugging)
 *
 * No test framework: test files call test() from tests/lib/tiny.js, this
 * script drains the registry per file and runs them. Exit code is non-zero
 * if anything failed. */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const env = require("./lib/env");
const { drain } = require("./lib/tiny");
const { startServer } = require("./lib/server");

const CHROME = process.env.LUMEN_CHROME ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = __dirname;

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `[${code}m${s}[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), yellow = (s) => c(33, s),
      dim = (s) => c(90, s), bold = (s) => c(1, s);

function parseArgs(argv) {
  const out = { filters: [], grep: null, jobs: 4 };
  for (const a of argv) {
    if (a.startsWith("--jobs=")) out.jobs = Math.max(1, parseInt(a.slice(7), 10) || 1);
    else if (a.startsWith("--grep=")) out.grep = new RegExp(a.slice(7), "i");
    else if (!a.startsWith("-")) out.filters.push(a);
  }
  return out;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${label}`)), ms); }),
  ]);
}

async function runGroup(group, opts, results) {
  const lines = [];
  for (const t of group.tests) {
    if (opts.grep && !opts.grep.test(t.name)) continue;
    if (t.skip && !(process.env.LUMEN_RUN_SKIPPED && t.fn)) {
      results.push({ file: group.file, name: t.name, status: "skip", reason: t.reason, ms: 0 });
      lines.push(`  ${yellow("SKIP")} ${t.name} ${dim("— " + t.reason)}`);
      continue;
    }
    const t0 = Date.now();
    try {
      await withTimeout(Promise.resolve().then(t.fn), t.timeout || 30000, t.name);
      const ms = Date.now() - t0;
      results.push({ file: group.file, name: t.name, status: "pass", ms });
      lines.push(`  ${green("PASS")} ${t.name} ${dim(ms + "ms")}`);
    } catch (err) {
      const ms = Date.now() - t0;
      results.push({ file: group.file, name: t.name, status: "fail", ms, err });
      lines.push(`  ${red("FAIL")} ${t.name} ${dim(ms + "ms")}`);
      lines.push(dim("       " + String((err && err.message) || err).split("\n").join("\n       ")));
    }
  }
  return lines;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));

  let files = fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .sort();
  if (opts.filters.length) {
    files = files.filter((f) => opts.filters.some((x) => f.includes(x)));
  }
  if (!files.length) { console.error("no test files matched"); process.exit(1); }

  if (!fs.existsSync(CHROME)) {
    console.error(`Chromium not found at ${CHROME}\n` +
      `Set LUMEN_CHROME to the browser binary (do not run "playwright install").`);
    process.exit(1);
  }

  const srv = await startServer(ROOT);
  env.root = ROOT;
  env.baseURL = srv.url;
  env.browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

  /* Require every file first (drain() is a shared registry, so collection
     must not interleave with parallel execution). */
  const groups = [];
  for (const f of files) {
    require(path.join(TESTS_DIR, f));
    groups.push({ file: f, tests: drain() });
  }

  const started = Date.now();
  const results = [];
  const output = new Map();

  let cursor = 0;
  const worker = async () => {
    while (cursor < groups.length) {
      const g = groups[cursor++];
      output.set(g.file, await runGroup(g, opts, results));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.jobs, groups.length) }, worker));

  for (const g of groups) {
    const lines = output.get(g.file) || [];
    if (!lines.length) continue;
    console.log("\n" + bold(g.file));
    for (const l of lines) console.log(l);
  }

  await env.browser.close();
  await srv.close();

  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail");
  const skip = results.filter((r) => r.status === "skip").length;
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log("\n" + "─".repeat(60));
  console.log(`${bold("Lumen suite")}  ${green(pass + " passed")}` +
    (fail.length ? `  ${red(fail.length + " failed")}` : "") +
    (skip ? `  ${yellow(skip + " skipped")}` : "") +
    `  ${dim("in " + secs + "s")}`);
  if (fail.length) {
    console.log("");
    for (const f of fail) {
      console.log(red("FAILED ") + f.file + " › " + f.name);
      console.log(dim("  " + String((f.err && f.err.stack) || f.err).split("\n").slice(0, 6).join("\n  ")));
    }
  }
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error("runner crashed:", e);
  process.exit(1);
});
