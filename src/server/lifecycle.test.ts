/**
 * R6-A4: the startup "Open" line must never carry the auth token into stdout.
 *
 * The token is hidden inside an OSC-8 hyperlink escape, so the leak is
 * invisible to the eye — this guard fails loudly if a future edit puts the
 * token back into either the link target or the visible text.
 */
import { describe, it, expect } from "vitest";
import { buildOpenLine } from "./lifecycle.js";

describe("buildOpenLine (R6-A4)", () => {
  it("emits no token — neither in the OSC-8 link target nor the visible text", () => {
    const line = buildOpenLine(8787, "/home/u/.lax/.startup-url");
    expect(line).not.toContain("token");
    expect(line).not.toContain("?");
  });

  it("still links to the loopback app origin and points at the sign-in URL file", () => {
    const line = buildOpenLine(8787, "/home/u/.lax/.startup-url");
    expect(line).toContain("http://127.0.0.1:8787/");
    expect(line).toContain("/home/u/.lax/.startup-url");
  });
});
