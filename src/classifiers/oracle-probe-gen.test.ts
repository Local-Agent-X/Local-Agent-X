import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the classifier seam so these tests never touch a live provider — they
// isolate the generator's own logic (spec guard, language inference, parse,
// null-degrade). classifyWithLLM returns the POST-parse value, so the mock
// stands in for "what the model produced after parseProbe".
vi.mock("./classify-with-llm.js", () => ({ classifyWithLLM: vi.fn() }));

import { generateOracleProbe, probeLanguageFor, parseProbe } from "./oracle-probe-gen.js";
import { classifyWithLLM } from "./classify-with-llm.js";

const mockClassify = vi.mocked(classifyWithLLM);

describe("probeLanguageFor — interpreter from edited file extensions", () => {
  it("python for .py, node for JS/TS, shell as the catch-all", () => {
    expect(probeLanguageFor(["wordy.py"])).toBe("python");
    expect(probeLanguageFor(["src/a.ts", "b.js"])).toBe("node");
    expect(probeLanguageFor(["main.go"])).toBe("shell");
    expect(probeLanguageFor([])).toBe("shell");
  });
});

describe("parseProbe — only a probe that can actually FAIL counts", () => {
  it("keeps a script with an assertion (strips an accidental fence)", () => {
    expect(parseProbe("assert answer('x') == 5")).toContain("assert");
    expect(parseProbe("```python\nassert x == 1\n```")).toBe("assert x == 1");
    expect(parseProbe("raise SystemExit(1) if bad else None")).toContain("raise");
    expect(parseProbe('[ "$out" = "OK" ] || exit 1')).toContain("exit 1");
  });

  it("rejects the NONE sentinel, empty, and assertion-less scripts", () => {
    expect(parseProbe("NONE")).toBeNull();
    expect(parseProbe("")).toBeNull();
    expect(parseProbe("print('hello world')")).toBeNull(); // proves nothing → worthless
  });
});

describe("generateOracleProbe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a probe tagged with the inferred language on a good spec", async () => {
    mockClassify.mockResolvedValueOnce("assert answer('What is 5?') == 5" as never);
    const probe = await generateOracleProbe({
      userRequest: "Evaluate word problems like 'What is 5 plus 3?' and raise ValueError('unknown operation').",
      fileList: ["wordy.py"],
    });
    expect(probe).not.toBeNull();
    expect(probe!.language).toBe("python");
    expect(probe!.script).toContain("assert");
  });

  it("degrades to null when the classifier is unavailable (self-check off / timeout)", async () => {
    mockClassify.mockResolvedValueOnce(null as never);
    const probe = await generateOracleProbe({ userRequest: "A real task with enough length to anchor.", fileList: ["a.py"] });
    expect(probe).toBeNull();
  });

  it("does not even call the model on a too-short spec (nothing to anchor)", async () => {
    const probe = await generateOracleProbe({ userRequest: "fix it", fileList: ["a.py"] });
    expect(probe).toBeNull();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("feeds the language-specific author prompt (python vs node)", async () => {
    mockClassify.mockResolvedValue("assert True" as never);
    await generateOracleProbe({ userRequest: "Implement the roster per the spec above, sorted.", fileList: ["grade_school.py"] });
    expect(String(mockClassify.mock.calls[0][0].systemPrompt)).toContain("Python 3");
    vi.clearAllMocks();
    mockClassify.mockResolvedValue("expect(x).toBe(1)" as never);
    await generateOracleProbe({ userRequest: "Implement the transpose per the spec above.", fileList: ["transpose.ts"] });
    expect(String(mockClassify.mock.calls[0][0].systemPrompt)).toContain("Node.js");
  });

  it("authors with the ACTIVE model tier and passes the API surface (the invalid-class fix)", async () => {
    // Locks two measured lessons (2026-07-02): the background non-reasoning tier
    // authored the probes (never the flagship the design named), and a bare file
    // list made it invent APIs → ModuleNotFound/AttributeError invalids.
    mockClassify.mockResolvedValue("assert True" as never);
    await generateOracleProbe({
      userRequest: "Implement wordy per the spec above with enough length.",
      fileList: ["wordy.py"],
      apiSurface: "# wordy.py\ndef answer(question)",
    });
    const call = mockClassify.mock.calls[0][0];
    expect(call.modelTier).toBe("active");
    expect(String(call.userPrompt)).toContain("def answer(question)");
    expect(String(call.userPrompt)).toContain("EXACTLY these names");
  });

  it("forbids guessed computed values and steers to invariants (the false-red class-fix)", async () => {
    // Locks the 2026-07-02 measured lesson: a blind author asserting a computed
    // output it had to solve for (two-bucket move count) false-reds correct code.
    mockClassify.mockResolvedValue("assert True" as never);
    await generateOracleProbe({ userRequest: "Return the number of moves needed to reach the goal amount.", fileList: ["two_bucket.py"] });
    const sys = String(mockClassify.mock.calls[0][0].systemPrompt);
    expect(sys).toMatch(/FORBIDDEN/);
    expect(sys).toMatch(/INVARIANT/i);
    expect(sys).toMatch(/comput/i);
    // Abstention must stay a LAST RESORT: framed as "correct and expected for
    // search tasks", the reasoning tier obediently replied NONE on every
    // search-shaped exercise (2026-07-02) and the gate went dark.
    expect(sys).toMatch(/LAST RESORT/);
    expect(sys).toMatch(/never merely because/);
  });
});
