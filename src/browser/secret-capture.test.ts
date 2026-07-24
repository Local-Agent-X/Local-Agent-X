import { describe, it, expect, vi, beforeEach } from "vitest";

// Two properties under test:
//   1. The captured value NEVER appears in the tool's returned content — it
//      goes DOM → vault and the result carries only name/service/length.
//   2. Overwrite guard: capturing into a name that already exists is refused
//      unless overwrite: true is passed, and the refusal does NOT touch the vault.

// Browser barrel: control the page value the tool reads, and bypass the mutex.
let currentOps: SecretBrowserOps;
let pageValue: string | null = null;

vi.mock("./index.js", () => ({
  getSecretBrowserOps: () => currentOps,
  withBrowserLock: async <T>(_sid: string, fn: () => Promise<T>) => fn(),
}));

import { createBrowserSecretCaptureTool } from "./secret-capture.js";
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

  it("refuses to overwrite an existing name and does NOT touch the vault", async () => {
    const existing: SecretMetaView = { name: SECRET_NAME, service: "Clover", addedAt: 0, updatedAt: 0 };
    const { store, set } = buildStore(existing);
    const tool = createBrowserSecretCaptureTool(store, () => "test-session");

    const result = await tool.execute({ name: SECRET_NAME, text_selector: "code#token" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
    expect(result.content).toContain("overwrite: true");
    expect(result.content).toContain("Clover");
    // Guard must fire before any write — the stored value is untouched.
    expect(set).not.toHaveBeenCalled();
  });

  it("overwrites when overwrite: true is passed", async () => {
    const existing: SecretMetaView = { name: SECRET_NAME, service: "Clover", addedAt: 0, updatedAt: 0 };
    const { store, set } = buildStore(existing);
    const tool = createBrowserSecretCaptureTool(store, () => "test-session");

    const result = await tool.execute({ name: SECRET_NAME, text_selector: "code#token", overwrite: true });

    expect(result.isError).not.toBe(true);
    expect(set).toHaveBeenCalledWith(SECRET_NAME, SECRET_VALUE, expect.anything());
    expect(result.content).not.toContain(SECRET_VALUE);
  });
});
