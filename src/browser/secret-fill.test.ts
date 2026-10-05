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
let holdsEmail = false;
let pageOrigin = "https://example.com";
let fillApproved = true;

vi.mock("./index.js", () => ({
  getSecretBrowserOps: () => currentOps,
  withBrowserLock: async <T>(_sid: string, fn: () => Promise<T>) => fn(),
}));

// The in-chat approval card: answered by the test.
const { approvals } = vi.hoisted(() => ({ approvals: { answer: true, asked: [] as Array<{ context: string }> } }));
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({
    requestApprovalDetailed: async (opts: { context: string }) => {
      approvals.asked.push(opts);
      return approvals.answer ? { approved: true } : { approved: false, reason: "declined" };
    },
  }),
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
import { EMULATION_PRESETS, setSessionEmulation, _resetSessionEmulationForTest } from "./emulation.js";
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
    currentOrigin: async () => pageOrigin,
    describeElement: async () => ({ ...elementDescriptor }),
    readValue: async () => null,
    fillValue: async () => {
      if (opts.fillThrows) throw new Error("fill failed");
      return opts.outcome;
    },
    pressEnter: async () => undefined,
    visibleValues: async () => [],
    markRef: async (id: number) => `[data-lax-ref="${id}"]`,
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
    isFillApproved: vi.fn(() => fillApproved),
    approveFill: vi.fn(() => true),
    holdsEmailAddress: vi.fn(() => holdsEmail),
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
  holdsEmail = false;
  pageOrigin = ORIGIN;
  fillApproved = true;
  approvals.answer = true;
  approvals.asked.length = 0;
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

// This tool reaches the page through getSecretBrowserOps, which follows the
// emulation override — so while a profile is installed the credential goes into
// the PRIVATE emulated context, not the user's logged-in view. It does not go
// through the browser dispatcher, so it carried none of the standing notice the
// dispatcher applies, and its own result said only "Filled … on <origin>".
describe("browser_fill_from_secret — the standing emulation notice", () => {
  beforeEach(() => { _resetSessionEmulationForTest(); });

  it("labels the result while the session is emulating — success AND refusal", async () => {
    setSessionEmulation("test-session", EMULATION_PRESETS.iphone);
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");

    const okResult = await tool.execute({ name: SECRET_NAME, selector: "#pw" });
    expect(okResult.isError).not.toBe(true);
    expect(okResult.content).toContain("[emulating]");
    expect(okResult.content).toContain("not the browser window the user is looking at");
    expect(okResult.content).toContain("Filled");
    assertNoSecretLeak([okResult.content, ...auditCalls]);

    elementDescriptor = { found: false, tag: "", type: "", autocomplete: "" };
    const errResult = await tool.execute({ name: SECRET_NAME, selector: "#pw" });
    expect(errResult.isError).toBe(true);
    expect(errResult.content).toContain("[emulating]");
  });

  it("says nothing when the session is not emulating", async () => {
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const tool = createBrowserSecretFillTool(buildStore(), () => "test-session");

    const result = await tool.execute({ name: SECRET_NAME, selector: "#pw" });

    expect(result.content).not.toContain("[emulating]");
  });
});

// Twilio's sign-in page marks its email box with nothing (type=text, no
// autocomplete). A stored login EMAIL is an account name, so it may go there;
// anything else in the vault still only goes into a credential field.
describe("browser_fill_from_secret — a login email into an unmarked box", () => {
  const unmarked = { found: true, tag: "input", type: "text", autocomplete: "" };

  it("fills a stored email address into a plain text box on its site", async () => {
    elementDescriptor = { ...unmarked };
    holdsEmail = true;
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const result = await createBrowserSecretFillTool(buildStore(), () => "test-session").execute({ name: SECRET_NAME, selector: "#email" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Filled");
  });

  it("still refuses any other secret there", async () => {
    elementDescriptor = { ...unmarked };
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const result = await createBrowserSecretFillTool(buildStore(), () => "test-session").execute({ name: SECRET_NAME, selector: "#email" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Refused to fill");
    assertNoSecretLeak([result.content, ...auditCalls]);
  });

  it("does not stretch to boxes that are not for an address", async () => {
    holdsEmail = true;
    currentOps = buildOps({ outcome: { kind: "landed" } });
    for (const el of [{ ...unmarked, type: "search" }, { ...unmarked, tag: "textarea", type: "" }]) {
      elementDescriptor = el;
      const result = await createBrowserSecretFillTool(buildStore(), () => "test-session").execute({ name: SECRET_NAME, selector: "#q" });
      expect(result.isError, `${el.tag}[type=${el.type}]`).toBe(true);
    }
  });
});

// Twilio signs in at login.twilio.com for a login saved on www.twilio.com. A
// sibling origin of the same site is filled once the user approves it in the
// chat; another site never is, and nothing is filled silently.
describe("browser_fill_from_secret — where a login may be filled", () => {
  const emit = () => undefined;
  const fill = (store = buildStore()) =>
    createBrowserSecretFillTool(store, () => "other-session").execute({ name: SECRET_NAME, selector: "#pw", _onEvent: emit });

  it("asks the user, in the chat, before the first fill on another page of the same site", async () => {
    pageOrigin = "https://login.example.com";
    fillApproved = false;
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const store = buildStore();
    const result = await fill(store);
    expect(result.isError).not.toBe(true);
    expect(approvals.asked).toHaveLength(1);
    expect(approvals.asked[0].context).toContain("saved for https://example.com");
    expect(store.approveFill).toHaveBeenCalledWith(SECRET_NAME, "https://login.example.com");
    assertNoSecretLeak([result.content, approvals.asked[0].context, ...auditCalls]);
  });

  it("fills nothing when the user says no", async () => {
    pageOrigin = "https://login.example.com";
    fillApproved = false;
    approvals.answer = false;
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const result = await fill();
    expect(result.status).toBe("declined");
    expect(redactedRegistrations).toEqual([]);
  });

  it("never fills another site, and does not ask", async () => {
    pageOrigin = "https://example-login.attacker.test";
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const result = await fill();
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cross-origin fill blocked");
    expect(approvals.asked).toHaveLength(0);
  });

  it("asks before the first fill on the secret's own origin too, instead of sending the user to Settings", async () => {
    fillApproved = false;
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const result = await fill();
    expect(result.isError).not.toBe(true);
    expect(approvals.asked).toHaveLength(1);
  });
});

describe("browser_fill_from_secret — by snapshot ref", () => {
  it("fills through the ref the backend's registry resolves", async () => {
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const result = await createBrowserSecretFillTool(buildStore(), () => "test-session").execute({ name: SECRET_NAME, ref: 64 });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Filled");
  });

  it("says the ref is gone, instead of 'element not found' for a selector no page has", async () => {
    currentOps = { ...buildOps({ outcome: { kind: "landed" } }), markRef: async () => null };
    const result = await createBrowserSecretFillTool(buildStore(), () => "test-session").execute({ name: SECRET_NAME, ref: 64 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Ref [64] is not on the page any more");
  });
});

// Twilio asked the user to approve filling their own email address. An email
// is an account name, not a credential: it needs no approval, but it still
// goes only to its own site.
describe("browser_fill_from_secret — a login email needs no approval", () => {
  it("fills an email address on its site without asking", async () => {
    holdsEmail = true;
    fillApproved = false;
    elementDescriptor = { found: true, tag: "input", type: "text", autocomplete: "" };
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const result = await createBrowserSecretFillTool(buildStore(), () => "other-session").execute({ name: SECRET_NAME, selector: "#email", _onEvent: () => undefined });
    expect(result.isError).not.toBe(true);
    expect(approvals.asked).toHaveLength(0);
  });

  it("still never fills it on another site", async () => {
    holdsEmail = true;
    pageOrigin = "https://twilio-login.attacker.test";
    currentOps = buildOps({ outcome: { kind: "landed" } });
    const result = await createBrowserSecretFillTool(buildStore(), () => "other-session").execute({ name: SECRET_NAME, selector: "#email" });
    expect(result.content).toContain("Cross-origin fill blocked");
  });
});
