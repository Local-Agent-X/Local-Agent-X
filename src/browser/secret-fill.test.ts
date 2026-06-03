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

// Browser barrel: control what page the tool gets, and bypass the mutex.
interface FakeLocator {
  inputValue: () => Promise<string>;
  fill: (val: string) => Promise<void>;
  press: (key: string) => Promise<void>;
}
interface FakePage {
  url: () => string;
  evaluate: (script: string) => Promise<unknown>;
  fill: (sel: string, val: string) => Promise<void>;
  locator: (selector: string) => FakeLocator;
}

let currentPage: FakePage;
let elementDescriptor = { found: true, tag: "input", type: "password", autocomplete: "current-password" };

vi.mock("./index.js", () => ({
  getBrowserManager: () => ({
    getPage: async () => currentPage,
  }),
  withBrowserLock: async <T>(_sid: string, fn: () => Promise<T>) => fn(),
}));

// Pre-bless: always empty (don't take that gate).
vi.mock("../operations/executor.js", () => ({
  getActivePreBlessedSecrets: () => new Set<string>(),
}));

vi.mock("../operations/conductor.js", () => ({
  loadOperation: () => null,
}));

// Capture redaction registrations (and assert secret IS handed to the redactor —
// that's the GOOD path; redaction registry is internal and never leaks).
vi.mock("../sanitize.js", () => ({
  registerRedactedSecretValue: (v: string) => { redactedRegistrations.push(v); },
}));

// ───────────────────────── imports after mocks ─────────────────────────
import { createBrowserSecretFillTool } from "./secret-fill.js";
import type { SecretsStore } from "../secrets.js";

const ORIGIN = "https://example.com";
const SECRET_NAME = "GH_TOKEN";
const SECRET_VALUE = "super-secret-token-zzzZZZ-1234567890";

function buildPage(opts: {
  readback: string;
  fillThrows?: boolean;
}): FakePage {
  return {
    url: () => `${ORIGIN}/login`,
    evaluate: async () => ({ ...elementDescriptor }),
    fill: async () => {
      if (opts.fillThrows) throw new Error("fill failed");
    },
    locator: () => ({
      inputValue: async () => opts.readback,
      fill: async () => {
        if (opts.fillThrows) throw new Error("fill failed");
      },
      press: async () => undefined,
    }),
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
  it("plain text + matching readback → ok, no secret in message or logs", async () => {
    elementDescriptor = { found: true, tag: "input", type: "text", autocomplete: "username" };
    currentPage = buildPage({ readback: SECRET_VALUE });

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

  it("plain text + length mismatch → err with 'length mismatch', NO secret in message or logs", async () => {
    elementDescriptor = { found: true, tag: "input", type: "text", autocomplete: "username" };
    currentPage = buildPage({ readback: "decoy-value-that-came-back-instead" });

    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
    const result = await tool.execute({ name: SECRET_NAME, selector: "#user" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Secret fill did not land/);
    expect(result.content).toMatch(/length mismatch/);

    // SECURITY: error message must not include the secret OR the actual readback
    // (the readback could itself be a sensitive value we just happened to read).
    assertNoSecretLeak([result.content, ...auditCalls]);
    expect(result.content).not.toContain("decoy-value-that-came-back-instead");
    for (const line of auditCalls) {
      expect(line).not.toContain("decoy-value-that-came-back-instead");
    }

    // The mismatch event SHOULD have been audited (so we can spot leaks-from-the-page).
    const mismatchLogged = auditCalls.some((l) => l.includes("fill_mismatch"));
    expect(mismatchLogged).toBe(true);
  });

  it("password input + empty readback → ok with skip note", async () => {
    elementDescriptor = { found: true, tag: "input", type: "password", autocomplete: "current-password" };
    currentPage = buildPage({ readback: "" });

    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
    const result = await tool.execute({ name: SECRET_NAME, selector: "#pw" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("verification skipped: masked input");
    assertNoSecretLeak([result.content, ...auditCalls]);
  });

  it("hidden input + empty readback → ok with skip note", async () => {
    elementDescriptor = { found: true, tag: "input", type: "hidden", autocomplete: "current-password" };
    currentPage = buildPage({ readback: "" });

    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
    const result = await tool.execute({ name: SECRET_NAME, selector: "#hidden-token" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("verification skipped: masked input");
    assertNoSecretLeak([result.content, ...auditCalls]);
  });

  it("readback machinery throws → ok with readback-failed skip note (does not leak)", async () => {
    elementDescriptor = { found: true, tag: "input", type: "password", autocomplete: "current-password" };
    currentPage = {
      url: () => `${ORIGIN}/login`,
      evaluate: async () => ({ ...elementDescriptor }),
      fill: async () => undefined,
      locator: () => ({
        inputValue: () => Promise.reject(new Error("Target closed")),
        fill: async () => undefined,
        press: async () => undefined,
      }),
    };

    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");
    const result = await tool.execute({ name: SECRET_NAME, selector: "#pw" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("verification skipped: readback failed");
    assertNoSecretLeak([result.content, ...auditCalls]);
  });
});
