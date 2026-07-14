import { describe, expect, it } from "vitest";
import { buildChromeLaunchArgs } from "./launcher.js";

// Regression: agent Chrome must launch with no initial about:blank window.
// Every session opens its own tab via a fresh per-session CDP context and never
// adopts the default-context startup page, so without this flag that page lingers
// as a stray blank window beside the real one. See launcher.ts buildChromeLaunchArgs.
describe("buildChromeLaunchArgs", () => {
  const args = () => buildChromeLaunchArgs(9333, "/tmp/ud", "/tmp/dl", "", false);

  it("suppresses Chrome's startup window", () => {
    expect(args()).toContain("--no-startup-window");
  });

  it("still wires the CDP port and profile dir", () => {
    const a = args();
    expect(a).toContain("--remote-debugging-port=9333");
    expect(a).toContain("--user-data-dir=/tmp/ud");
  });

  it("only goes headless when asked", () => {
    expect(buildChromeLaunchArgs(9333, "/tmp/ud", "/tmp/dl", "", false)).not.toContain("--headless=new");
    expect(buildChromeLaunchArgs(9333, "/tmp/ud", "/tmp/dl", "", true)).toContain("--headless=new");
  });
});
