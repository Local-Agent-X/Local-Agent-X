/**
 * Loopback CDP endpoint discovery (cdp-endpoint.ts). The switch-append is a
 * one-line Chromium side effect; the logic worth testing is parsing the
 * DevToolsActivePort file Chromium writes and the polling/timeout that reads
 * it before the server child spawns.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  parseDevToolsActivePort,
  resolveLoopbackCdpPort,
  getLoopbackCdpPort,
} from "./cdp-endpoint";

describe("parseDevToolsActivePort", () => {
  it("reads the port from the first line (ignoring the ws path on line 2)", () => {
    expect(parseDevToolsActivePort("52913\n/devtools/browser/abc")).toBe(52913);
    expect(parseDevToolsActivePort("52913")).toBe(52913);
    expect(parseDevToolsActivePort("52913\r\n/devtools/browser/abc")).toBe(52913);
  });

  it("rejects malformed or out-of-range content", () => {
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("not-a-port")).toBeNull();
    expect(parseDevToolsActivePort("0")).toBeNull();
    expect(parseDevToolsActivePort("70000")).toBeNull();
    expect(parseDevToolsActivePort("  12ab\n")).toBeNull();
  });
});

describe("resolveLoopbackCdpPort", () => {
  const dirs: string[] = [];
  const freshDir = () => {
    const d = mkdtempSync(join(tmpdir(), "cdp-endpoint-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("resolves and caches the port once DevToolsActivePort exists", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "DevToolsActivePort"), "49123\n/devtools/browser/x");
    const port = await resolveLoopbackCdpPort({ userDataDir: dir, timeoutMs: 500 });
    expect(port).toBe(49123);
    expect(getLoopbackCdpPort()).toBe(49123); // cached for the server-spawn env
  });

  it("picks up the file if it appears slightly after the first poll", async () => {
    const dir = freshDir();
    setTimeout(() => writeFileSync(join(dir, "DevToolsActivePort"), "50044"), 60);
    const port = await resolveLoopbackCdpPort({ userDataDir: dir, timeoutMs: 1000, pollMs: 20 });
    expect(port).toBe(50044);
  });

  it("returns null (and caches null) when the file never appears within the timeout", async () => {
    const dir = freshDir();
    const port = await resolveLoopbackCdpPort({ userDataDir: dir, timeoutMs: 120, pollMs: 20 });
    expect(port).toBeNull();
    expect(getLoopbackCdpPort()).toBeNull();
  });
});
