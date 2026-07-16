import { describe, it, expect, vi, beforeEach } from "vitest";

// The security property under test:
//   The plaintext secret value MUST NEVER appear in:
//     - the tool's returned content (success OR error)
//     - any audit log call (mocked via the logger module)
//     - any error message
//
// Plus the readback policy:
//   - matching length / matching value          → ok (no skip note)
//   - empty + type=password                     → ok with skip note
//   - empty + type=hidden                       → ok with skip note
//   - empty + non-masked + length mismatch path → err with length-mismatch
//                                                  (secret value NEVER in msg)

// ───────────────────────── module mocks ─────────────────────────
// Captures every audit log call so we can assert the secret never appears.
// vi.mock factories are hoisted above imports, so the captured state must
// also be hoisted with vi.hoisted() to be in scope at factory eval time.
const { auditCalls, loggerMock, redactedRegistrations } = vi.hoisted(() => {
  const auditCalls: string[] = [];
  const redactedRegistrations: string[] = [];
  const loggerMock = {
    warn: (line: string) => { auditCalls.push(line); },
    info: (line: string) => { auditCalls.push(line); },
    error: (line: string) => { auditCalls.push(line); },
    debug: (line: string) => { auditCalls.push(line); },
  };
  return { auditCalls, loggerMock, redactedRegistrations };
});

vi.mock("../logger.js", () => ({
  createLogger: () => loggerMock,
}));

// Browser barrel: control the page access the tool gets, and bypass the mutex.
// The tool now drives SecretBrowserOps, which both backends implement — so this
// fake stands in for either one, and every assertion below holds on both.
let currentOps: SecretBrowserOps;
let elementDescriptor = { found: true, tag: "input", type: "password", autocomplete: "current-password" };

vi.mock("./index.js", () => ({
  getSecretBrowserOps: () => currentOps,
  withBrowserLock: async <T>(_sid: string, fn: () => Promise<T>) => fn(),
}));

// Pre-bless: always empty (don't take that gate).
vi.mock("../ops/pre-bless.js", () => ({
  getActivePreBlessedSecrets: () => new Set<string>(),
}));

// Capture redaction registrations (and assert secret IS handed to the redactor —
// that's the GOOD path; redaction registry is internal and never leaks).
vi.mock("../sanitize.js", () => ({
  registerRedactedSecretValue: (v: string) => { redactedRegistrations.push(v); },
}));

// ───────────────────────── imports after mocks ─────────────────────────
import { createBrowserSecretFillTool } from "./secret-fill.js";
import type { SecretsStore } from "../secrets.js";
import type { SecretBrowserOps, SecretFillOutcome } from "./secret-ops.js";

const ORIGIN = "https://example.com";
const SECRET_NAME = "GH_TOKEN";
const SECRET_VALUE = "super-secret-token-zzzZZZ-1234567890";

function buildOps(opts: {
  outcome: SecretFillOutcome;
  fillThrows?: boolean;
}): SecretBrowserOps {
  return {
    currentOrigin: async () => ORIGIN,
    describeElement: async () => ({ ...elementDescriptor }),
    readValue: async () => null,
    fillValue: async () => {
      if (opts.fillThrows) throw new Error("fill failed");
      return opts.outcome;
    },
    pressEnter: async () => undefined,
  };
}

function buildStore(): SecretsStore {
  return {
    getMeta: vi.fn(() => ({
      name: SECRET_NAME,
      origin: ORIGIN,
      createdBySession: "test-session",
      addedAt: 0,
      updatedAt: 0,
    })),
    get: vi.fn(() => SECRET_VALUE),
    isFillApproved: vi.fn(() => true),
  } as unknown as SecretsStore;
}

function assertNoSecretLeak(haystacks: Array<string | undefined>): void {
  for (const h of haystacks) {
    if (!h) continue;
    expect(h).not.toContain(SECRET_VALUE);
    // Also guard against accidental prefix/suffix leakage.
    expect(h).not.toContain(SECRET_VALUE.slice(0, 8));
    expect(h).not.toContain(SECRET_VALUE.slice(-8));
  }
}

beforeEach(() => {
  auditCalls.length = 0;
  redactedRegistrations.length = 0;
  elementDescriptor = { found: true, tag: "input", type: "password", autocomplete: "current-password" };
  vi.clearAllMocks();
});

describe("browser_fill_from_secret — readback never leaks the secret", () => {
  it("landed → ok, no secret in message or logs", async () => {
    elementDescriptor = { found: true, tag: "input", type: "text", autocomplete: "username" };
    currentOps = buildOps({ outcome: { kind: "landed" } });

    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
    const result = await tool.execute({ name: SECRET_NAME, selector: "#user" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Filled");
    expect(result.content).toContain(`Length: ${SECRET_VALUE.length} chars`);
    expect(result.content).not.toContain("verification skipped");

    // Critical: the value is not echoed back to the model.
    assertNoSecretLeak([result.content, ...auditCalls]);

    // Sanity: the value WAS registered with the redactor on success.
    expect(redactedRegistrations).toContain(SECRET_VALUE);
  });

  it("mismatch → err, NO secret in message or logs", async () => {
    elementDescriptor = { found: true, tag: "input", type: "text", autocomplete: "username" };
    currentOps = buildOps({ outcome: { kind: "mismatch" } });

    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
    const result = await tool.execute({ name: SECRET_NAME, selector: "#user" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Secret fill did not land/);
    expect(result.content).toMatch(/value mismatch/);
    assertNoSecretLeak([result.content, ...auditCalls]);

    // The mismatch event SHOULD have been audited (so we can spot leaks-from-the-page).
    const mismatchLogged = auditCalls.some((l) => l.includes("fill_mismatch"));
    expect(mismatchLogged).toBe(true);
  });

  it("masked-unverifiable → ok with skip note", async () => {
    elementDescriptor = { found: true, tag: "input", type: "password", autocomplete: "current-password" };
    currentOps = buildOps({ outcome: { kind: "masked-unverifiable" } });

    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
    const result = await tool.execute({ name: SECRET_NAME, selector: "#pw" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("verification skipped: masked input");
    assertNoSecretLeak([result.content, ...auditCalls]);
  });

  it("not-found / not-fillable → err naming the shape, not the value", async () => {
    elementDescriptor = { found: true, tag: "input", type: "password", autocomplete: "current-password" };
    for (const kind of ["not-found", "not-fillable"] as const) {
      auditCalls.length = 0;
      currentOps = buildOps({ outcome: { kind } });
      const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
      const result = await tool.execute({ name: SECRET_NAME, selector: "#pw" });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Fill failed/);
      assertNoSecretLeak([result.content, ...auditCalls]);
    }
  });

  it("a throwing fill reports failure and does not leak", async () => {
    // The write and its verification are one in-page step now, so a throw means
    // the outcome is genuinely unknown — report failure rather than the old
    // "readback failed but we'll call it a success" note, which guessed.
    elementDescriptor = { found: true, tag: "input", type: "password", autocomplete: "current-password" };
    currentOps = buildOps({ outcome: { kind: "landed" }, fillThrows: true });

    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
    const result = await tool.execute({ name: SECRET_NAME, selector: "#pw" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Fill failed/);
    assertNoSecretLeak([result.content, ...auditCalls]);
  });
});
