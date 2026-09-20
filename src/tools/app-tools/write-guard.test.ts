/**
 * What a rejected write TELLS the model.
 *
 * The guard's job is not only to block; a block the model cannot act on costs
 * a whole turn. Two live failures on 2026-09-20, in one function:
 *  - the CDN block said "Inline or self-host" and named no way to GET the
 *    bytes, so the model wrote the same <link> to fonts.googleapis.com again;
 *  - every rejection was rendered through one CDN-flavoured tail, so a write
 *    missing a viewport meta tag was told the preview blocks external CDNs.
 *
 * Both are the same mistake: one remedy bolted onto every reason. So what is
 * pinned here is that each rejection carries ITS OWN remedy, and that a
 * remedy names a route the model can actually take.
 */
import { describe, it, expect } from "vitest";
import { checkAppWrite, writeGuardRejectionMessage } from "./write-guard.js";

/** Only paths under a workspace apps dir are guarded at all. */
const APP = "/home/u/workspace/apps/demo/index.html";
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** What the tool layer actually surfaces (edit-tools.ts / read-write-tools.ts). */
const surfaced = (r: ReturnType<typeof checkAppWrite>): string =>
  r.message ?? writeGuardRejectionMessage(r.reason ?? "policy violation");

describe("a blocked CDN write names a route the model can take", () => {
  it("sends a font CDN to a system stack or http_request, not to 'self-host' alone", () => {
    const r = checkAppWrite(APP, `<html><head>${VIEWPORT}<link href="https://fonts.googleapis.com/css2?family=Inter"></head></html>`);
    expect(r.allow).toBe(false);
    const msg = surfaced(r);
    expect(msg).toContain("fonts.googleapis.com");
    expect(msg).toContain("http_request");
    expect(msg).toMatch(/system-ui/);
  });

  it("sends a script CDN to http_request plus a local path", () => {
    const r = checkAppWrite(APP, `<html><head>${VIEWPORT}<script src="https://cdn.tailwindcss.com"></script></head></html>`);
    expect(r.allow).toBe(false);
    const msg = surfaced(r);
    expect(msg).toContain("cdn.tailwindcss.com");
    expect(msg).toContain("http_request");
    expect(msg, "a font remedy does not belong on a script block").not.toMatch(/system-ui/);
  });
});

describe("a rejection does not borrow another rejection's remedy", () => {
  it("the viewport block explains the viewport, and says nothing about CDNs", () => {
    const r = checkAppWrite(APP, `<html><head><title>x</title></head><body>${"y".repeat(400)}</body></html>`);
    expect(r.allow).toBe(false);
    const msg = surfaced(r);
    expect(msg).toContain("width=device-width");
    expect(msg.toLowerCase(), "the viewport block used to send the model to read about CDNs").not.toContain("cdn");
    expect(msg).not.toContain("AGENTS.md");
  });

  it("the generic fallback carries no remedy at all, so it cannot carry a wrong one", () => {
    const msg = writeGuardRejectionMessage("policy violation");
    expect(msg).toBe("Write rejected: policy violation.");
    expect(msg.toLowerCase()).not.toContain("cdn");
  });
});

describe("the guard still allows what it should", () => {
  it("a clean app page passes", () => {
    expect(checkAppWrite(APP, `<html><head>${VIEWPORT}</head><body>hello</body></html>`).allow).toBe(true);
  });

  it("a file outside the apps dir is not guarded — CDN or not", () => {
    expect(checkAppWrite("/home/u/notes/index.html", '<script src="https://unpkg.com/x"></script>').allow).toBe(true);
  });

  it("a short html sliver skips the viewport requirement", () => {
    expect(checkAppWrite(APP, "<p>one small edit</p>").allow).toBe(true);
  });
});
