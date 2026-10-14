import { describe, it, expect, vi, beforeEach } from "vitest";

// Two properties under test:
//   1. The captured value NEVER appears in the tool's returned content — it
//      goes DOM → vault and the result carries only name/service/length.
//   2. No overwrite from the model (ADR 0005): capturing into a name that
//      already exists is refused with that record's service and account, there
//      is no override, and the refusal does NOT touch the vault.

// Browser barrel: control the page value the tool reads, and bypass the mutex.
let currentOps: SecretBrowserOps;
let pageValue: string | null = null;

vi.mock("./index.js", () => ({
  getSecretBrowserOps: () => currentOps,
  withBrowserLock: async <T>(_sid: string, fn: () => Promise<T>) => fn(),
}));

import { createBrowserSecretCaptureTool } from "./secret-capture.js";
import { EMULATION_PRESETS, setSessionEmulation, _resetSessionEmulationForTest } from "./emulation.js";
import type { SecretsStore } from "../secrets.js";
import type { SecretBrowserOps } from "./secret-ops.js";
import type { SecretMetaView } from "../secrets-types.js";

const ORIGIN = "https://example.com";
const SECRET_NAME = "CLOVER_API_TOKEN";
const SECRET_VALUE = "sk_live_abcdef1234567890-DO-NOT-LEAK";

function buildOps(): SecretBrowserOps {
  return {
    currentOrigin: async () => ORIGIN,
    describeElement: async () => ({ found: false, tag: "", type: "", autocomplete: "" }),
    readValue: async () => pageValue,
    fillValue: async () => ({ kind: "landed" }),
    pressEnter: async () => undefined,
    visibleValues: async () => [],
    markRef: async () => null,
  };
}

function buildStore(existing?: SecretMetaView): { store: SecretsStore; set: ReturnType<typeof vi.fn> } {
  const set = vi.fn();
  const store = {
    getMeta: vi.fn(() => existing),
    set,
  } as unknown as SecretsStore;
  return { store, set };
}

beforeEach(() => {
  pageValue = SECRET_VALUE;
  currentOps = buildOps();
  vi.clearAllMocks();
});

describe("browser_capture_to_secret", () => {
  it("captures a fresh name → ok, value written to vault but never in the result", async () => {
    const { store, set } = buildStore(undefined);
    const tool = createBrowserSecretCaptureTool(store, () => "test-session");

    const result = await tool.execute({ name: SECRET_NAME, service: "Clover", text_selector: "code#token" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain(SECRET_NAME);
    expect(result.content).toContain(`${SECRET_VALUE.length} chars`);
    // The value must not leak into the model-visible result.
    expect(result.content).not.toContain(SECRET_VALUE);
    expect(result.content).not.toContain(SECRET_VALUE.slice(0, 8));
    // It WAS written to the vault.
    expect(set).toHaveBeenCalledWith(SECRET_NAME, SECRET_VALUE, expect.objectContaining({ service: "Clover" }));
  });

  it("refuses an existing name with its service and account, names a distinct one, and does NOT touch the vault", async () => {
    const existing: SecretMetaView = { name: SECRET_NAME, service: "Clover", account: "owner@shop.example", addedAt: 0, updatedAt: 0 };
    const { store, set } = buildStore(existing);
    const tool = createBrowserSecretCaptureTool(store, () => "test-session");

    const result = await tool.execute({ name: SECRET_NAME, account: "staff@shop.example", text_selector: "code#token" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
    expect(result.content).toContain("service: Clover, account: owner@shop.example");
    expect(result.content).toContain("never overwritten");
    expect(result.content).toContain(`${SECRET_NAME}_STAFF_SHOP_EXAMPLE`);
    // Guard must fire before any write — the stored value is untouched.
    expect(set).not.toHaveBeenCalled();
  });

  it("has no override: an overwrite flag is not a parameter and does not replace the record", async () => {
    const existing: SecretMetaView = { name: SECRET_NAME, service: "Clover", addedAt: 0, updatedAt: 0 };
    const { store, set } = buildStore(existing);
    const tool = createBrowserSecretCaptureTool(store, () => "test-session");

    expect(Object.keys(tool.parameters.properties as Record<string, unknown>)).not.toContain("overwrite");
    const result = await tool.execute({ name: SECRET_NAME, text_selector: "code#token", overwrite: true });

    expect(result.isError).toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  // getSecretBrowserOps follows the emulation override, so while a profile is
  // installed this reads the PRIVATE emulated context — a logged-out page — and
  // not the user's window. This tool does not go through the browser dispatcher,
  // so the standing notice has to be applied by the tool itself.
  describe("the standing emulation notice", () => {
    beforeEach(() => { _resetSessionEmulationForTest(); });

    it("labels the result while the session is emulating", async () => {
      setSessionEmulation("test-session", EMULATION_PRESETS.iphone);
      const { store } = buildStore(undefined);
      const tool = createBrowserSecretCaptureTool(store, () => "test-session");

      const result = await tool.execute({ name: SECRET_NAME, text_selector: "code#token" });

      expect(result.content).toContain("[emulating]");
      expect(result.content).toContain("not the browser window the user is looking at");
      expect(result.content).not.toContain(SECRET_VALUE);
    });

    it("says nothing when the session is not emulating", async () => {
      const { store } = buildStore(undefined);
      const tool = createBrowserSecretCaptureTool(store, () => "test-session");

      const result = await tool.execute({ name: SECRET_NAME, text_selector: "code#token" });

      expect(result.content).not.toContain("[emulating]");
    });
  });
});
