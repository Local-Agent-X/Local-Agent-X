import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceRegistry, setDeviceRegistryForTest, getDeviceRegistry, hashBridgeToken } from "./device-registry.js";
import { issueChallenge, claim, clearPendingForTest, PAIRING_TTL_MS } from "./pairing.js";
import { authorizeUpgrade, authorizeDeviceHttp, clearLiveSocketsForTest } from "./upgrade-auth.js";
import { isTailnetAddr, detectTailnetAddr } from "./tailnet.js";
import { buildPairQrPayload, encodePairQrPayload, PAIR_PAYLOAD_VERSION } from "./pair-payload.js";
import { resetPersistedBridgeEnabledForTest } from "./config.js";
import { reloadSettings } from "../settings.js";

const OP_TOKEN = "OP_" + "a".repeat(61); // any non-empty operator token

let tmp: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bridge-test-"));
  // Relocate ~/.lax into the tmp dir so the persisted bridge.enabled flag the
  // upgrade gate now consults can't be polluted by the real user settings.
  prevDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tmp;
  reloadSettings();
  resetPersistedBridgeEnabledForTest();
  // Fresh registry pointed at a throwaway data dir, shared via the singleton so
  // pairing.claim() and the upgrade gate hit the SAME registry.
  setDeviceRegistryForTest(new DeviceRegistry(tmp));
  clearPendingForTest();
  clearLiveSocketsForTest();
  // Bridge ON for device-token paths; individual tests flip it off to prove the
  // default loopback-only posture.
  process.env.LAX_BRIDGE_ENABLED = "1";
});

afterEach(() => {
  setDeviceRegistryForTest(null);
  delete process.env.LAX_BRIDGE_ENABLED;
  delete process.env.LAX_BRIDGE_BIND_ADDR;
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  reloadSettings();
  resetPersistedBridgeEnabledForTest();
  rmSync(tmp, { recursive: true, force: true });
});

describe("pairing claim — happy path", () => {
  it("mints a device token once and records its HASH (never the raw token)", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    expect(challenge.pairingSecret).toBeTruthy();

    const result = claim(challenge.pairingSecret, "Peter's iPhone");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("claim should succeed");
    expect(result.deviceToken).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex
    expect(result.device.label).toBe("Peter's iPhone");
    expect(result.device.status).toBe("active");

    // Registry stores only the hash. (DeviceRecord shape has tokenHash; list()
    // omits it — assert the raw token never appears in the persisted view.)
    const reg = new DeviceRegistry(tmp); // reload from disk
    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(result.deviceToken);
    // But the on-disk hash matches the minted token.
    expect(reg.authenticate(result.deviceToken)?.id).toBe(result.device.id);
    expect(reg.get(result.device.id)?.tokenHash).toBe(hashBridgeToken(result.deviceToken));
  });
});

describe("pairing secret is one-shot + time-boxed", () => {
  it("rejects a REUSED secret (the 409 path)", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    const first = claim(challenge.pairingSecret, "Phone A");
    expect(first.ok).toBe(true);

    const second = claim(challenge.pairingSecret, "Phone B");
    expect(second.ok).toBe(false); // route maps this to HTTP 409
  });

  it("rejects an EXPIRED secret (the 409 path)", () => {
    const realNow = Date.now;
    const challenge = issueChallenge("100.100.1.2:7007");
    try {
      // Jump past the TTL so the secret is stale at claim time.
      Date.now = () => realNow() + PAIRING_TTL_MS + 1;
      const result = claim(challenge.pairingSecret, "Phone");
      expect(result.ok).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects an UNKNOWN secret", () => {
    const result = claim("never-issued-secret", "Phone");
    expect(result.ok).toBe(false);
  });
});

describe("upgrade gate — device tokens", () => {
  it("accepts the operator token regardless of bridge state (loopback unchanged)", () => {
    process.env.LAX_BRIDGE_ENABLED = "1";
    expect(authorizeUpgrade(OP_TOKEN, OP_TOKEN)).toMatchObject({ ok: true, principal: "operator" });
    delete process.env.LAX_BRIDGE_ENABLED;
    expect(authorizeUpgrade(OP_TOKEN, OP_TOKEN)).toMatchObject({ ok: true, principal: "operator" });
  });

  it("accepts a freshly paired device token", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    const claimed = claim(challenge.pairingSecret, "Phone");
    if (!claimed.ok) throw new Error("setup");
    const auth = authorizeUpgrade(claimed.deviceToken, OP_TOKEN);
    expect(auth).toMatchObject({ ok: true, principal: "device", deviceId: claimed.device.id });
  });

  it("REJECTS a revoked device token at the upgrade layer (4401 + reason)", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    const claimed = claim(challenge.pairingSecret, "Phone");
    if (!claimed.ok) throw new Error("setup");

    // Revoke on the live singleton (claim() registered the device there).
    const reg = getDeviceRegistry();
    expect(reg.revoke(claimed.device.id)).toBe(true);

    const auth = authorizeUpgrade(claimed.deviceToken, OP_TOKEN);
    expect(auth.ok).toBe(false);
    expect(auth.reason).toMatch(/revoked|re-pair/i);
  });

  it("REJECTS an unknown token", () => {
    const auth = authorizeUpgrade("not-a-real-token", OP_TOKEN);
    expect(auth.ok).toBe(false);
    expect(auth.reason).toBeTruthy();
  });

  it("when the bridge is OFF, a device token is NOT honored (pre-change behavior)", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    const claimed = claim(challenge.pairingSecret, "Phone");
    if (!claimed.ok) throw new Error("setup");
    delete process.env.LAX_BRIDGE_ENABLED; // bridge OFF
    const auth = authorizeUpgrade(claimed.deviceToken, OP_TOKEN);
    expect(auth).toMatchObject({ ok: false, reason: "Unauthorized" });
  });
});

describe("device HTTP scope", () => {
  it("a device token reaches /api/apps but NOT /api/secrets", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    const claimed = claim(challenge.pairingSecret, "Phone");
    if (!claimed.ok) throw new Error("setup");

    expect(authorizeDeviceHttp(claimed.deviceToken, "/api/apps")).not.toBeNull();
    expect(authorizeDeviceHttp(claimed.deviceToken, "/api/apps/foo/state")).not.toBeNull();
    expect(authorizeDeviceHttp(claimed.deviceToken, "/api/secrets/X/reveal")).toBeNull();
    expect(authorizeDeviceHttp(claimed.deviceToken, "/api/chat")).toBeNull();
  });

  it("with the bridge OFF, no HTTP path is device-authorized", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    const claimed = claim(challenge.pairingSecret, "Phone");
    if (!claimed.ok) throw new Error("setup");
    delete process.env.LAX_BRIDGE_ENABLED;
    expect(authorizeDeviceHttp(claimed.deviceToken, "/api/apps")).toBeNull();
  });
});

describe("pairing QR payload — desktop↔mobile contract", () => {
  it("wraps the challenge in the versioned {v,tailnetAddr,pairingSecret,expiresAt} shape the phone parses", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    const payload = buildPairQrPayload(challenge);
    // Exact field set the mobile chunk-3 parser expects — no more, no less.
    expect(Object.keys(payload).sort()).toEqual(["expiresAt", "pairingSecret", "tailnetAddr", "v"]);
    expect(payload.v).toBe(PAIR_PAYLOAD_VERSION);
    expect(payload.v).toBe(1);
    expect(payload.tailnetAddr).toBe(challenge.tailnetAddr);
    expect(payload.pairingSecret).toBe(challenge.pairingSecret);
    expect(payload.expiresAt).toBe(challenge.expiresAt);
  });

  it("encodePairQrPayload round-trips back to the same payload object (what the desktop puts in the QR)", () => {
    const challenge = issueChallenge("100.100.1.2:7007");
    const str = encodePairQrPayload(challenge);
    const parsed = JSON.parse(str) as ReturnType<typeof buildPairQrPayload>;
    expect(parsed).toEqual(buildPairQrPayload(challenge));
    // v comes first so a phone can cheaply version-check before trusting the rest.
    expect(str.startsWith('{"v":1')).toBe(true);
  });
});

describe("tailnet detection", () => {
  it("classifies 100.64.0.0/10 CGNAT addresses, rejects others", () => {
    expect(isTailnetAddr("100.64.0.1")).toBe(true);
    expect(isTailnetAddr("100.100.50.7")).toBe(true);
    expect(isTailnetAddr("100.127.255.254")).toBe(true);
    expect(isTailnetAddr("100.63.0.1")).toBe(false); // below range
    expect(isTailnetAddr("100.128.0.1")).toBe(false); // above range
    expect(isTailnetAddr("192.168.1.1")).toBe(false);
    expect(isTailnetAddr("100.64.0")).toBe(false); // malformed
    expect(isTailnetAddr("not.an.ip.addr")).toBe(false);
  });

  it("detectTailnetAddr returns a CGNAT addr or null (never throws)", () => {
    const addr = detectTailnetAddr();
    expect(addr === null || isTailnetAddr(addr)).toBe(true);
  });
});
