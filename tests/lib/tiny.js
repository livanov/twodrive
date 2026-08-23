"use strict";
/* A hand-rolled micro test framework: `test(name, fn)` + assertions.
   Test files simply call test(); run.js requires the file and drains
   the registry. No jest/mocha. */

const registry = [];

function test(name, fn, opts) {
  registry.push({ name, fn, skip: false, timeout: (opts && opts.timeout) || 30000 });
}
/* Documented-as-skipped test: still listed in the summary, never run.
   Used for behaviour we believe is buggy (see tests/README.md) so the
   suite stays green while the finding stays visible. */
test.skip = function (name, reason) {
  registry.push({ name, fn: null, skip: true, reason: reason || "skipped" });
};

function drain() {
  const out = registry.slice();
  registry.length = 0;
  return out;
}

/* ---------------- assertions ---------------- */
class AssertionError extends Error {}

function fail(msg) {
  throw new AssertionError(msg);
}
function ok(v, msg) {
  if (!v) fail(msg || `expected truthy, got ${fmt(v)}`);
}
function notOk(v, msg) {
  if (v) fail(msg || `expected falsy, got ${fmt(v)}`);
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    fail(`${msg ? msg + ": " : ""}expected ${fmt(expected)}, got ${fmt(actual)}`);
  }
}
function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) fail(`${msg ? msg + ": " : ""}expected ${b}, got ${a}`);
}
function match(str, re, msg) {
  if (!re.test(String(str))) {
    fail(`${msg ? msg + ": " : ""}expected ${fmt(str)} to match ${re}`);
  }
}
function notMatch(str, re, msg) {
  if (re.test(String(str))) {
    fail(`${msg ? msg + ": " : ""}expected ${fmt(str)} NOT to match ${re}`);
  }
}
function includes(haystack, needle, msg) {
  const has = Array.isArray(haystack) ? haystack.includes(needle) : String(haystack).includes(needle);
  if (!has) fail(`${msg ? msg + ": " : ""}expected ${fmt(haystack)} to include ${fmt(needle)}`);
}
function gte(actual, min, msg) {
  if (!(actual >= min)) fail(`${msg ? msg + ": " : ""}expected ${fmt(actual)} >= ${fmt(min)}`);
}
function lte(actual, max, msg) {
  if (!(actual <= max)) fail(`${msg ? msg + ": " : ""}expected ${fmt(actual)} <= ${fmt(max)}`);
}
function fmt(v) {
  if (typeof v === "string") return JSON.stringify(v.length > 300 ? v.slice(0, 300) + "…" : v);
  try { const s = JSON.stringify(v); return s && s.length > 300 ? s.slice(0, 300) + "…" : String(s); }
  catch (e) { return String(v); }
}

module.exports = {
  test, drain, AssertionError,
  assert: { ok, notOk, eq, deepEq, match, notMatch, includes, gte, lte, fail },
};
