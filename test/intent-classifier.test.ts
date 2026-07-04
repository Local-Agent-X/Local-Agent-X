import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub classify-with-llm so tests are deterministic — no provider creds,
// no network. The stub stores the last call's args so the test can
// confirm the system prompt + user message reached the classifier.
const __scripted = new Map<string, unknown>();
let __lastUserPrompt = "";

vi.mock("../src/classifiers/classify-with-llm.js", () => ({
  classifyJson: vi.fn(async (args: {
    userPrompt: string;
    validate?: (o: unknown) => unknown;
  }) => {
    __lastUserPrompt = args.userPrompt;
    // Pull script by matching the literal user message embedded in the
    // userPrompt (the classifier wraps it in quotes — find the segment).
    for (const [needle, scripted] of __scripted) {
      if (args.userPrompt.includes(needle)) {
        return args.validate ? args.validate(scripted) : scripted;
      }
    }
    return null;
  }),
  classifyWithLLM: vi.fn(async () => null),
  classifyYesNo: vi.fn(async () => null),
}));

const { classifyIntent, hasLiteralToolCall, NO_SPAWN_OVERRIDE_RE, buildHistoryDigest } =
  await import("../src/classifiers/intent-classifier.js");

function script(messageNeedle: string, verdict: unknown) {
  __scripted.set(messageNeedle, verdict);
}

beforeEach(() => {
  __scripted.clear();
  __lastUserPrompt = "";
});

describe("intent-classifier — positive cases", () => {
  it("create a dashboard that imports our fastmail → build_app", async () => {
    const msg = "can you create a dashboard that imports our fastmail";
    script(msg, { kind: "build_app", reason: "creating a new dashboard" });
    const v = await classifyIntent(msg);
    expect(v?.kind).toBe("build_app");
    expect(v?.reason).toContain("dashboard");
  });

  it("research current AI voice toolkits → agent_spawn", async () => {
    const msg = "research current AI voice toolkits and write a summary";
    script(msg, { kind: "agent_spawn", reason: "long-running research delegation" });
    const v = await classifyIntent(msg);
    expect(v?.kind).toBe("agent_spawn");
  });

  it("the dark mode toggle doesn't flip → self_edit", async () => {
    const msg = "the dark mode toggle doesn't flip when I click it";
    script(msg, { kind: "self_edit", reason: "LAX bug" });
    const v = await classifyIntent(msg);
    expect(v?.kind).toBe("self_edit");
  });
});

describe("intent-classifier — negative (free) cases", () => {
  it("what's the weather → free", async () => {
    const msg = "what's the weather";
    script(msg, { kind: "free", reason: "casual question" });
    const v = await classifyIntent(msg);
    expect(v?.kind).toBe("free");
  });

  it("explain how you'd build a dashboard → free (discussion)", async () => {
    const msg = "explain how you'd build a dashboard";
    script(msg, { kind: "free", reason: "asking for explanation" });
    const v = await classifyIntent(msg);
    expect(v?.kind).toBe("free");
  });

  it("thanks → free", async () => {
    const msg = "thanks";
    script(msg, { kind: "free", reason: "ack" });
    const v = await classifyIntent(msg);
    expect(v?.kind).toBe("free");
  });

  it("returns null when classifier yields nothing usable", async () => {
    // No script entry → mock returns null.
    const v = await classifyIntent("totally novel message with no script");
    expect(v).toBeNull();
  });

  it("returns null on empty message without calling the LLM", async () => {
    const v = await classifyIntent("   ");
    expect(v).toBeNull();
    expect(__lastUserPrompt).toBe("");
  });

  it("rejects an invalid kind value", async () => {
    const msg = "trigger invalid";
    script(msg, { kind: "nonsense", reason: "x" });
    const v = await classifyIntent(msg);
    expect(v).toBeNull();
  });
});

describe("intent-classifier — skip-condition helpers", () => {
  it("NO_SPAWN_OVERRIDE_RE matches 'don't delegate'", () => {
    expect(NO_SPAWN_OVERRIDE_RE.test("don't delegate, do it yourself")).toBe(true);
    expect(NO_SPAWN_OVERRIDE_RE.test("do not spawn a subagent")).toBe(true);
    expect(NO_SPAWN_OVERRIDE_RE.test("handle it yourself")).toBe(true);
    expect(NO_SPAWN_OVERRIDE_RE.test("you do it yourself please")).toBe(true);
  });

  it("NO_SPAWN_OVERRIDE_RE does not match ordinary text", () => {
    expect(NO_SPAWN_OVERRIDE_RE.test("create a dashboard")).toBe(false);
    expect(NO_SPAWN_OVERRIDE_RE.test("research X for me")).toBe(false);
  });

  it("hasLiteralToolCall detects tool_name({...}) pattern", () => {
    expect(hasLiteralToolCall("please run tool_search({\"q\":\"x\"})")).toBe(true);
    expect(hasLiteralToolCall("build_app({name:'kanban'})")).toBe(true);
    expect(hasLiteralToolCall("just a sentence with no tool call")).toBe(false);
    expect(hasLiteralToolCall("read this article: foo(bar)")).toBe(false);
  });
});

describe("buildHistoryDigest — Chunk 3 conversation context", () => {
  it("returns '' for empty history (classifier runs message-only)", () => {
    expect(buildHistoryDigest([])).toBe("");
  });

  it("keeps only the last N user/assistant turns, oldest→newest", () => {
    const msgs = [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "turn 2" },
      { role: "user", content: "turn 3" },
      { role: "assistant", content: "turn 4" },
    ];
    const d = buildHistoryDigest(msgs, { maxTurns: 2 });
    expect(d).toBe("User: turn 3\nAssistant: turn 4");
  });

  it("skips non-string content (tool-result blocks) and empty turns", () => {
    const msgs = [
      { role: "user", content: "real text" },
      { role: "assistant", content: [{ type: "tool_use", name: "x" }] },
      { role: "user", content: "   " },
      { role: "tool", content: "tool output" },
    ];
    expect(buildHistoryDigest(msgs)).toBe("User: real text");
  });

  it("caps total length, preserving the most recent turn", () => {
    const msgs = [
      { role: "user", content: "A".repeat(200) },
      { role: "assistant", content: "B".repeat(200) },
    ];
    const d = buildHistoryDigest(msgs, { maxChars: 50 });
    expect(d.length).toBeLessThanOrEqual(50);
    expect(d).toContain("B"); // newest survives; oldest trimmed from front
    expect(d.startsWith("…")).toBe(true);
  });

  it("digest reaches the classify prompt as labeled context", async () => {
    const msg = "yes build it";
    script(msg, { kind: "build_app", mode: "force", reason: "confirming prior spec" });
    const digest = "User: make me a BMI calculator with metric units\nAssistant: I can build that.";
    const v = await classifyIntent(msg, { historyDigest: digest });
    expect(v?.kind).toBe("build_app");
    expect(v?.mode).toBe("force");
    expect(__lastUserPrompt).toContain("Recent conversation");
    expect(__lastUserPrompt).toContain("BMI calculator");
    // The current message is still the classified subject.
    expect(__lastUserPrompt).toContain("yes build it");
  });

  it("omits the context block entirely when no digest is passed", async () => {
    const msg = "build me a kanban app";
    script(msg, { kind: "build_app", mode: "force", reason: "kanban is the spec" });
    await classifyIntent(msg);
    expect(__lastUserPrompt).not.toContain("Recent conversation");
  });
});

describe("intent-classifier — override case integration", () => {
  // These mirror the caller's skip-condition checks in prepare-request.ts
  // (NO_SPAWN_OVERRIDE_RE + hasLiteralToolCall). The classifier itself
  // doesn't enforce them; the caller chooses not to invoke when they fire.
  // These tests pin the helpers' behavior so the wiring stays correct.
  it("bridge channel: caller skips classifier (no test on classifier itself)", () => {
    // sentinel — the skip lives in prepare-request.ts, not here. We
    // assert below in prepare-request integration. For this unit-test
    // file, we just confirm the helpers used by the skip-condition exist
    // and behave.
    expect(typeof NO_SPAWN_OVERRIDE_RE.test).toBe("function");
    expect(typeof hasLiteralToolCall).toBe("function");
  });
});
