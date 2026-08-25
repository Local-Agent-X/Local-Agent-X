// device-paths tests — pin the phone tunnel's HTTP allowlist. This list is the
// ONLY boundary between the phone and the desktop's HTTP surface (the tunnel
// injects full operator auth on every proxied request), so widening it must be
// a conscious, reviewed act — this test makes a drive-by addition fail loudly.

import { describe, it, expect } from "vitest";
import { DEVICE_HTTP_PREFIXES, isDeviceAllowedPath } from "./device-paths.js";

describe("device allowlist", () => {
  it("is exactly the reviewed set — widening it requires updating this pin", () => {
    expect([...DEVICE_HTTP_PREFIXES].sort()).toEqual(
      ["/api/apps", "/api/providers", "/api/sessions", "/apps/", "/images/", "/uploads/", "/videos/"].sort(),
    );
  });

  it("allows the served-media prefixes the phone renders from", () => {
    for (const p of [
      "/uploads/abcd1234-budget.xlsx", // send_file staged doc
      "/uploads/photo.png",
      "/images/generated.png",
      "/videos/clip.mp4",
      "/api/sessions/mobile-123",
      "/api/apps",
      "/apps/foo/index.html",
      "/api/providers",
    ]) {
      expect(isDeviceAllowedPath(p), p).toBe(true);
    }
  });

  it("refuses the workspace-wide and operator surfaces", () => {
    for (const p of [
      "/files/anything.xlsx", // whole-workspace reach — deliberately NOT phone-reachable
      "/files/",
      "/api/chat",
      "/api/config",
      "/api/upload",
      "/api/artifacts",
      "/uploads", // no trailing slash → not the served prefix
      "/uploadsX/evil",
      "/",
    ]) {
      expect(isDeviceAllowedPath(p), p).toBe(false);
    }
  });
});
