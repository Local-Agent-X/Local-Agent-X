/**
 * What a page may ask the device for (camera, microphone, location) is decided in
 * one place: app-serving-policy.ts, whose app policy comes from the phone↔desktop
 * contract (vendor/apps.ts APP_DEVICE_CAPABILITIES). It was written out in three
 * files and they disagreed: a registered app got no camera at all, a workspace app
 * no location (2026-10-26). This fails when another file writes one again.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_APP_PERMISSIONS_POLICY } from "./app-serving-policy.js";
import { APP_DEVICE_CAPABILITIES } from "../broker-transport/vendor/index.js";

const SRC = join(__dirname, "..");
const OWNER = "server/app-serving-policy.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("Permissions-Policy has one source", () => {
  it("no file but app-serving-policy.ts writes a camera / microphone / location policy", () => {
    const writers = sourceFiles(SRC)
      .filter((f) => /\b(camera|microphone|geolocation)=\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f).replace(/\\/g, "/"));
    expect(writers).toEqual([OWNER]);
  });

  it("an app's policy is the contract's list, each for the app's own origin", () => {
    expect(AGENT_APP_PERMISSIONS_POLICY).toBe(APP_DEVICE_CAPABILITIES.map((c) => `${c}=(self)`).join(", "));
  });
});
