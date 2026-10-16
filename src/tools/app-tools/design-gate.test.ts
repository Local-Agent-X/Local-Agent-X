/**
 * The design system reaches an app's UI before its first file lands.
 *
 * Live 2026-10-16: the agent wrote a 33 KB page straight into workspace/apps/,
 * a post-write nudge then delivered the design system, and the page was
 * rewritten twice. What is pinned here is the order: no UI file reaches an app
 * in a session that has not been given the system, and once it has (by the
 * tool, by build_app, or by the refusal itself), writes go through.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppWrite } from "./write-guard.js";
import {
  appDesignBrief, designDelivered, markDesignDelivered, resetDesignDeliveries,
} from "./design-gate.js";

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const PAGE = `<html><head>${VIEWPORT}<title>Paper trading dashboard</title></head><body>${"x".repeat(300)}</body></html>`;

let root: string;
let apps: string;

beforeEach(() => {
  resetDesignDeliveries();
  root = mkdtempSync(join(tmpdir(), "design-gate-"));
  apps = join(root, "workspace", "apps");
  mkdirSync(apps, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LAX_APP_DESIGN_GUARD;
});

describe("the first UI write to an app carries the design system", () => {
  it("refuses a new app's first page and hands over the archetype brief in the refusal", () => {
    const r = checkAppWrite(join(apps, "bot", "index.html"), PAGE, "s1");
    expect(r.allow).toBe(false);
    expect(r.message).toContain("Nothing was written");
    expect(r.message).toContain("DESIGN SYSTEM");
    expect(r.message).toContain("CRAFT");
    expect(r.message, "the refusal names the tool that avoids it next time").toContain("app_design_brief");
  });

  it("lets the retry through: the refusal itself delivered the system", () => {
    const path = join(apps, "bot", "index.html");
    expect(checkAppWrite(path, PAGE, "s1").allow).toBe(false);
    expect(checkAppWrite(path, PAGE, "s1").allow).toBe(true);
    expect(checkAppWrite(join(apps, "bot", "styles.css"), "body{}", "s1").allow).toBe(true);
  });

  it("gives an existing app the craft rules, not a new archetype", () => {
    mkdirSync(join(apps, "old"), { recursive: true });
    writeFileSync(join(apps, "old", "index.html"), PAGE);
    const r = checkAppWrite(join(apps, "old", "index.html"), PAGE, "s1");
    expect(r.allow).toBe(false);
    expect(r.message).toContain("already exists");
    expect(r.message).not.toContain("DESIGN SYSTEM —");
    expect(r.message).toContain("CRAFT");
  });

  it("is checked before the CDN rule, so one rewrite covers both", () => {
    const r = checkAppWrite(join(apps, "bot", "index.html"), `${PAGE}<link href="https://fonts.googleapis.com/css2">`, "s1");
    expect(r.message).toContain("DESIGN SYSTEM");
  });

  it("is per session: another conversation has not seen it", () => {
    const path = join(apps, "bot", "index.html");
    markDesignDelivered("s1", "bot");
    expect(checkAppWrite(path, PAGE, "s1").allow).toBe(true);
    expect(checkAppWrite(path, PAGE, "s2").allow).toBe(false);
  });

  it("leaves non-UI files alone", () => {
    expect(checkAppWrite(join(apps, "bot", "PROJECT.md"), "# Bot", "s1").allow).toBe(true);
    expect(checkAppWrite(join(apps, "bot", "data.json"), "{}", "s1").allow).toBe(true);
    expect(designDelivered("s1", "bot")).toBe(false);
  });

  it("can be switched off", () => {
    process.env.LAX_APP_DESIGN_GUARD = "0";
    expect(checkAppWrite(join(apps, "bot", "index.html"), PAGE, "s1").allow).toBe(true);
  });
});

describe("app_design_brief delivers it ahead of the write", () => {
  const brief = (args: Record<string, unknown>) =>
    appDesignBrief.execute(args) as Promise<{ content: string; isError?: boolean }>;

  it("returns the system and records it, so the first write lands", async () => {
    const res = await brief({ app: "gate-test-new-app", description: "crypto trading dashboard", _sessionId: "s1" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("DESIGN SYSTEM");
    expect(res.content).toContain("CRAFT");
    expect(designDelivered("s1", "gate-test-new-app")).toBe(true);
    expect(checkAppWrite(join(apps, "gate-test-new-app", "index.html"), PAGE, "s1").allow).toBe(true);
  });

  it("refuses a path in place of a folder name", async () => {
    const res = await brief({ app: "../etc", description: "x", _sessionId: "s1" });
    expect(res.isError).toBe(true);
  });
});
