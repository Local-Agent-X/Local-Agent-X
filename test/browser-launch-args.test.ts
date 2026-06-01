import { describe, it, expect } from "vitest";
import { STEALTH_ARGS, DISABLE_FEATURES } from "../src/browser/launcher.js";

// Regression guard for the silent --disable-features clobber: Chrome honors
// only the LAST --disable-features occurrence, so every disable must flow
// through the single DISABLE_FEATURES list and be passed as one flag.
// RendererCodeIntegrity and --no-process-per-site were removed because they
// weaken Chrome's renderer integrity / site isolation.

describe("browser launch args — single --disable-features flag", () => {
  it("STEALTH_ARGS no longer carries its own --disable-features entry", () => {
    expect(STEALTH_ARGS.some((a) => a.startsWith("--disable-features="))).toBe(false);
  });

  it("STEALTH_ARGS drops the isolation-weakening flags", () => {
    expect(STEALTH_ARGS).not.toContain("--no-process-per-site");
    expect(STEALTH_ARGS.some((a) => /RendererCodeIntegrity/.test(a))).toBe(false);
  });

  it("DISABLE_FEATURES holds the intended features and excludes RendererCodeIntegrity", () => {
    expect(DISABLE_FEATURES).toContain("Translate");
    expect(DISABLE_FEATURES).toContain("MediaRouter");
    expect(DISABLE_FEATURES).toContain("DownloadBubble");
    expect(DISABLE_FEATURES).toContain("DownloadBubbleV2");
    expect(DISABLE_FEATURES as readonly string[]).not.toContain("RendererCodeIntegrity");
  });

  it("the effective disable-features flag is a single flag", () => {
    const flag = `--disable-features=${DISABLE_FEATURES.join(",")}`;
    expect(flag.indexOf("--disable-features")).toBe(0);
    expect(flag.indexOf("--disable-features", 1)).toBe(-1);
  });
});
