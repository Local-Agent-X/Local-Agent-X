// Regression: clicking the in-app xAI "Open sign-in page" link did nothing.
// handleWindowOpen classified external-vs-local with `includes("127.0.0.1")`,
// but the OAuth authorize URL carries redirect_uri=http://127.0.0.1:.../callback
// in its query — so the accounts.x.ai link was misread as loopback, denied, and
// never opened in the browser. Must classify by hostname.
import { describe, it, expect } from "vitest";
import { isExternalBrowserUrl } from "../desktop/src/url-classify";

const XAI_AUTH_URL =
  "https://accounts.x.ai/authorize?response_type=code&client_id=abc" +
  "&redirect_uri=" + encodeURIComponent("http://127.0.0.1:56121/callback") +
  "&scope=openid&state=xyz";

describe("isExternalBrowserUrl", () => {
  it("treats an OAuth URL with a 127.0.0.1 redirect_uri as EXTERNAL (the bug)", () => {
    expect(isExternalBrowserUrl(XAI_AUTH_URL)).toBe(true);
  });

  it("treats the local app origin as internal", () => {
    expect(isExternalBrowserUrl("http://127.0.0.1:7007/apps/mario/")).toBe(false);
    expect(isExternalBrowserUrl("http://localhost:7007/")).toBe(false);
  });

  it("opens normal external links externally", () => {
    expect(isExternalBrowserUrl("https://x.ai")).toBe(true);
    expect(isExternalBrowserUrl("https://github.com/foo/bar")).toBe(true);
  });

  it("ignores non-http(s) and unparseable URLs", () => {
    expect(isExternalBrowserUrl("mailto:a@b.com")).toBe(false);
    expect(isExternalBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalBrowserUrl("not a url")).toBe(false);
  });
});
