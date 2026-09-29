import { describe, expect, it } from "vitest";
import { chromeLaunchArgs, buildPersistentContextOptions } from "./launcher.js";

describe("chromeLaunchArgs", () => {
  const args = () => chromeLaunchArgs("/tmp/dl", "");

  // The agent's browser is driven over Playwright's pipe: no debugging port
  // may ever be opened, or a caged shell with loopback (macOS) could drive it.
  it("never opens a debugging port and leaves the profile dir to Playwright", () => {
    for (const a of args()) {
      expect(a).not.toMatch(/^--remote-debugging/);
      expect(a).not.toMatch(/^--user-data-dir/);
      expect(a).not.toMatch(/^--headless/);
    }
  });

  // Regression: without --use-mock-keychain, a Chrome creating a fresh profile
  // hits macOS Keychain Services for its Safe Storage key and the OS pops a
  // "Keychain Not Found" dialog at the user. --password-store=basic only
  // covers Linux; the mock keychain is the macOS counterpart.
  it("never touches the OS keychain", () => {
    const a = args();
    expect(a).toContain("--use-mock-keychain");
    expect(a).toContain("--password-store=basic");
  });

  it("is the one flag list every launch path uses", () => {
    expect(buildPersistentContextOptions("/tmp/dl", "http://127.0.0.1:43123").args).toEqual(chromeLaunchArgs("/tmp/dl", "http://127.0.0.1:43123"));
  });
});
