// A browser navigation to this app's own server always carries the real token.
// The model sees the token only masked (`abcd****`), so a self URL it copies
// back out of a tool result carries the mask — keeping "whatever token the URL
// already has" sent the browser to its own app with a token that cannot work.

import { describe, it, expect, beforeAll } from "vitest";
import { setBrowserAuthContext, injectTokenIfLocal } from "./auth-context.js";
import { deriveFilesLinkCapability } from "../server/agent-file-links.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PORT = "7311";
const tokenOf = (url: string): string | null => new URL(url).searchParams.get("token");

describe("injectTokenIfLocal", () => {
  beforeAll(() => setBrowserAuthContext(TOKEN, PORT));

  it("adds the token to a self URL that has none", () => {
    expect(tokenOf(injectTokenIfLocal(`http://127.0.0.1:${PORT}/tasks.html`))).toBe(TOKEN);
  });

  // The server redirects these to the agent origin (server/agent-origin.ts),
  // which must never see the operator token.
  it("never sends the token with an agent-built app or file, and drops a copied one", () => {
    for (const path of ["/apps/notes/", "/dashboards/board", "/files/report.html"]) {
      const out = injectTokenIfLocal(`http://127.0.0.1:${PORT}${path}?token=${TOKEN}`);
      expect(tokenOf(out), path).toBeNull();
      expect(out, path).not.toContain(TOKEN);
    }
  });

  it("gives a /files page the files-link capability its redirect asks for", () => {
    const out = new URL(injectTokenIfLocal(`http://127.0.0.1:${PORT}/files/report.html`));
    expect(out.searchParams.get("ft")).toBe(deriveFilesLinkCapability(TOKEN));
    expect(new URL(injectTokenIfLocal(`http://127.0.0.1:${PORT}/apps/notes/`)).searchParams.has("ft")).toBe(false);
  });

  it("replaces a masked token the model copied back with the real one", () => {
    const out = injectTokenIfLocal(`http://127.0.0.1:${PORT}/tasks.html?token=0123****&tab=2`);
    expect(tokenOf(out)).toBe(TOKEN);
    expect(new URL(out).searchParams.get("tab")).toBe("2");
    expect(out).not.toContain("****");
  });

  it("covers every loopback spelling the browser reaches without DNS", () => {
    for (const host of ["localhost", "LOCALHOST", "[::1]", "[0:0:0:0:0:0:0:1]"]) {
      expect(tokenOf(injectTokenIfLocal(`http://${host}:${PORT}/?token=stale`)), host).toBe(TOKEN);
    }
  });

  // The browser and its egress proxy resolve these through the OS resolver; a
  // hijacking resolver answering with a public IP would receive the token.
  it("never sends the token to a loopback alias that needs a DNS lookup", () => {
    for (const host of ["localhost.localdomain", "ip6-localhost", "ip6-loopback"]) {
      const url = `http://${host}:${PORT}/`;
      expect(injectTokenIfLocal(url), host).toBe(url);
    }
  });

  it("never adds or rewrites a token for another port or host", () => {
    for (const url of [
      `http://127.0.0.1:${Number(PORT) + 1}/?token=theirs`,
      `https://example.com:${PORT}/?token=theirs`,
      `http://127.0.0.2:${PORT}/?token=theirs`,
    ]) {
      expect(injectTokenIfLocal(url), url).toBe(url);
    }
  });
});
