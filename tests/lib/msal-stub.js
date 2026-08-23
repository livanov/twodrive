"use strict";
/* A stand-in for @azure/msal-browser.
 *
 * The real library is loaded from a CDN and there is no network in the test
 * environment, so we (a) define window.msal via page.addInitScript before the
 * app's inline script runs — which short-circuits loadMsal() — and (b) also
 * fulfil the three CDN script URLs with the same source, so the CDN code path
 * works too if anything ever reaches it.
 *
 * Every call is recorded on window.__msal.calls so tests can assert on the
 * requested scopes, redirects, sign-out, etc.
 */

const DEFAULT_ACCOUNT = {
  homeAccountId: "acct-home-1",
  localAccountId: "acct-local-1",
  environment: "login.windows.net",
  tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad",
  username: "tester@example.com",
  name: "Test Person",
};

/* opts:
 *   accounts   : array of MSAL accounts (default: one signed-in account); [] = signed out
 *   token      : access token string
 *   hangAt     : method name that never resolves (e.g. "handleRedirectPromise")
 *   silentFails: acquireTokenSilent rejects
 *   loadFails  : do not define window.msal at all (forces the CDN path)
 */
function msalStubSource(opts = {}) {
  const cfg = {
    accounts: opts.accounts === undefined ? [DEFAULT_ACCOUNT] : opts.accounts,
    token: opts.token || "FAKE_ACCESS_TOKEN",
    hangAt: opts.hangAt || null,
    silentFails: !!opts.silentFails,
  };
  return `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const rec = (window.__msal = window.__msal || { calls: [], config: null, redirected: null });
  const hang = (name) => CFG.hangAt === name ? new Promise(() => {}) : null;

  class PublicClientApplication {
    constructor(config){ rec.config = config; this._accounts = CFG.accounts.slice(); this._active = null; }
    async initialize(){ rec.calls.push({ m: "initialize" }); const h = hang("initialize"); if (h) return h; }
    async handleRedirectPromise(){
      rec.calls.push({ m: "handleRedirectPromise" });
      const h = hang("handleRedirectPromise"); if (h) return h;
      return null;
    }
    getAllAccounts(){ return this._accounts.slice(); }
    getAccountByHomeId(id){ return this._accounts.find(a => a.homeAccountId === id) || null; }
    setActiveAccount(a){ this._active = a; }
    getActiveAccount(){ return this._active; }
    async acquireTokenSilent(req){
      rec.calls.push({ m: "acquireTokenSilent", scopes: (req && req.scopes) || null });
      const h = hang("acquireTokenSilent"); if (h) return h;
      if (CFG.silentFails) throw new Error("interaction_required");
      return { accessToken: CFG.token, expiresOn: new Date(Date.now() + 3600e3), account: this._active };
    }
    async acquireTokenRedirect(req){
      rec.calls.push({ m: "acquireTokenRedirect", scopes: (req && req.scopes) || null });
      rec.redirected = "acquireTokenRedirect";
      return new Promise(() => {});   // the real thing navigates away
    }
    async loginRedirect(req){
      rec.calls.push({ m: "loginRedirect", scopes: (req && req.scopes) || null });
      rec.redirected = "loginRedirect";
      return new Promise(() => {});
    }
    async logoutRedirect(req){
      rec.calls.push({ m: "logoutRedirect", account: (req && req.account && req.account.username) || null });
      rec.redirected = "logoutRedirect";
    }
  }
  window.msal = { PublicClientApplication };
})();`;
}

module.exports = { msalStubSource, DEFAULT_ACCOUNT };
