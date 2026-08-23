"use strict";
/* Shared per-run state: the single Chromium instance and the static server's
   base URL. run.js fills these in before requiring any test file. */
module.exports = {
  browser: null,
  baseURL: null,
  root: null,
};
