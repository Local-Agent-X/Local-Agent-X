/**
 * tool-capability-probe tests — advisory evidence only, never a latch.
 *
 * The invariants under test:
 *   - ok:false requires a CLEAN finish_reason:"stop" with no structured call
 *     on BOTH attempts, and even then it never touches noTools — verified
 *     evidence informs UI/routing; only real turn failures latch.
 *   - truncation ("length"), missing finish_reason, HTTP and transport
 *     errors are inconclusive: null, nothing recorded, retried next process.
 *   - the lazy scheduler fires once per key per process, literal-loopback
 *     only (cloud AND LAN excluded), and never throws.
 *   - a real turn's structured tool call records {ok:true} with no fetch.
 *
 * fetch is stubbed so no probe ever leaves the process; the store runs
 * against a throwaway LAX_DATA_DIR. Each test uses a unique model name so
 * the in-memory once-per-process attempt guard never bleeds across tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyToolSupport, maybeVerifyToolSupport, noteLiveToolCallEvidence } from "./tool-capability-probe.js";
import { hasNoTools, getToolsVerified, recordNoTools, recordToolsVerified, _resetForTests } from "./model-capabilities-store.js";

const BASE = "http://localhost:11434/v1";

/** A 200 chat completion: first choice carries `message` + `finish_reason`. */
function completion(message: unknown, finishReason: unknown = "stop") {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message, finish_reason: finishReason }] }) };
}
const PING_CALL = {
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{}" } }],
};
const TEXT_ONLY = { content: "pong! happy to help." };

function sentBody(f: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((f.mock.calls[call][1] as { body: string }).body);
}

let dir: string;
const prevEnv = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-tool-probe-"));
  process.env.LAX_DATA_DIR = dir;
  _resetForTests();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  _resetForTests();
  vi.unstubAllGlobals();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("verifyToolSupport — outcomes and what they record", () => {
  it("a structured ping tool_call on the first try → {ok:true}, toolsVerified recorded, noTools untouched", async () => {
    const f = vi.fn().mockResolvedValue(completion(PING_CALL, "tool_calls"));
    vi.stubGlobal("fetch", f);

    const res = await verifyToolSupport(BASE, "tooly-live");

    expect(res).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("http://localhost:11434/v1/chat/completions");
    const body = sentBody(f);
    expect(body.tool_choice).toBe("auto");
    expect(body.max_tokens).toBe(256); // room for reasoning-first models
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect((body.tools as Array<{ function: { name: string } }>)[0].function.name).toBe("ping");
    const tv = getToolsVerified(BASE, "tooly-live");
    expect(tv?.ok).toBe(true);
    expect(Number.isNaN(Date.parse(tv?.at ?? ""))).toBe(false); // ISO timestamp
    expect(hasNoTools(BASE, "tooly-live")).toBe(false);
  });

  it("text-only clean stop, then a structured call when forced → {ok:true} (chatty ≠ incapable)", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(completion(TEXT_ONLY, "stop"))
      .mockResolvedValueOnce(completion(PING_CALL, "tool_calls"));
    vi.stubGlobal("fetch", f);

    expect(await verifyToolSupport(BASE, "chatty-live")).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sentBody(f, 1).tool_choice).toBe("required");
    expect(getToolsVerified(BASE, "chatty-live")?.ok).toBe(true);
  });

  it("clean stop with no call on BOTH attempts → advisory {ok:false} — and noTools stays FALSE (tools still sent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion(TEXT_ONLY, "stop")));

    expect(await verifyToolSupport(BASE, "prose-live")).toEqual({ ok: false });
    expect(getToolsVerified(BASE, "prose-live")?.ok).toBe(false);
    // THE separation of powers: the probe never latches. Only real turn
    // failures (400s, the loopback empty-with-tools latch) may strip tools.
    expect(hasNoTools(BASE, "prose-live")).toBe(false);
  });

  it("truncation: finish_reason 'length' on both attempts → null, nothing recorded (reasoning burn ≠ incapability)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ content: "Okay, let me think about which tool—" }, "length")));

    expect(await verifyToolSupport(BASE, "thinky-live")).toBeNull();
    expect(getToolsVerified(BASE, "thinky-live")).toBeUndefined();
    expect(hasNoTools(BASE, "thinky-live")).toBe(false);
  });

  it("mixed: truncated first attempt + clean-stop second → still null (ok:false needs BOTH attempts clean)", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(completion({ content: "thinking…" }, "length"))
      .mockResolvedValueOnce(completion(TEXT_ONLY, "stop"));
    vi.stubGlobal("fetch", f);

    expect(await verifyToolSupport(BASE, "half-live")).toBeNull();
    expect(getToolsVerified(BASE, "half-live")).toBeUndefined();
  });

  it("a missing finish_reason is inconclusive → null, nothing recorded", async () => {
    // The field is truly ABSENT (not undefined-passed-to-a-default): an
    // engine that never labels its stop gives us nothing to trust.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ choices: [{ message: TEXT_ONLY }] }),
    }));

    expect(await verifyToolSupport(BASE, "nofinish-live")).toBeNull();
    expect(getToolsVerified(BASE, "nofinish-live")).toBeUndefined();
  });

  it("an engine that 400s on tool_choice:'required' is inconclusive → null, nothing recorded", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(completion(TEXT_ONLY, "stop"))
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: "invalid tool_choice: required" } }) });
    vi.stubGlobal("fetch", f);

    expect(await verifyToolSupport(BASE, "no-required-live")).toBeNull();
    expect(getToolsVerified(BASE, "no-required-live")).toBeUndefined();
    expect(hasNoTools(BASE, "no-required-live")).toBe(false);
  });

  it("timeout/transport error → null, nothing recorded, never throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")));

    await expect(verifyToolSupport(BASE, "dead-live")).resolves.toBeNull();
    expect(getToolsVerified(BASE, "dead-live")).toBeUndefined();
    expect(hasNoTools(BASE, "dead-live")).toBe(false);
  });

  it("an HTTP error on the first attempt is also inconclusive → null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));

    expect(await verifyToolSupport(BASE, "err500-live")).toBeNull();
    expect(getToolsVerified(BASE, "err500-live")).toBeUndefined();
  });

  it("fuzzy name match: a mangled but recognizable ping name still verifies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "functions.Ping", arguments: "{}" } }],
    }, "stop")));

    expect(await verifyToolSupport(BASE, "fuzzy-live")).toEqual({ ok: true });
  });
});

describe("maybeVerifyToolSupport — lazy scheduler gates", () => {
  it("fires at most once per (baseURL, model) per process, including concurrent callers", async () => {
    const f = vi.fn().mockResolvedValue(completion(PING_CALL, "tool_calls"));
    vi.stubGlobal("fetch", f);

    await Promise.all([
      maybeVerifyToolSupport(BASE, "once-live"),
      maybeVerifyToolSupport(BASE, "once-live"), // in-flight duplicate
    ]);
    await maybeVerifyToolSupport(BASE, "once-live"); // later turn

    expect(f).toHaveBeenCalledTimes(1);
  });

  it("never fires for a cloud baseURL", async () => {
    const f = vi.fn().mockResolvedValue(completion(PING_CALL, "tool_calls"));
    vi.stubGlobal("fetch", f);

    await maybeVerifyToolSupport("https://api.example-frontier.test/v1", "cloud-live");

    expect(f).not.toHaveBeenCalled();
  });

  it("never fires for a LAN endpoint — literal loopback only; someone else's box is not probed", async () => {
    const f = vi.fn().mockResolvedValue(completion(PING_CALL, "tool_calls"));
    vi.stubGlobal("fetch", f);

    await maybeVerifyToolSupport("http://192.168.1.50:1234/v1", "lan-live");

    expect(f).not.toHaveBeenCalled();
    expect(getToolsVerified("http://192.168.1.50:1234/v1", "lan-live")).toBeUndefined();
  });

  it("skips keys the registry already answers — a real noTools latch or prior verified evidence", async () => {
    const f = vi.fn().mockResolvedValue(completion(PING_CALL, "tool_calls"));
    vi.stubGlobal("fetch", f);

    recordNoTools(BASE, "latched-live");
    await maybeVerifyToolSupport(BASE, "latched-live");

    recordToolsVerified(BASE, "seen-live", true);
    await maybeVerifyToolSupport(BASE, "seen-live");

    expect(f).not.toHaveBeenCalled();
  });

  it("a null (unreachable) attempt records nothing but still consumes this process's one attempt", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", f);

    await maybeVerifyToolSupport(BASE, "flaky-live");
    await maybeVerifyToolSupport(BASE, "flaky-live");

    expect(f).toHaveBeenCalledTimes(1);
    // Nothing persisted — the attempt guard is memory-only, so a fresh
    // process (fresh Set) retries this key on its first completed turn.
    expect(getToolsVerified(BASE, "flaky-live")).toBeUndefined();
    expect(hasNoTools(BASE, "flaky-live")).toBe(false);
  });
});

describe("noteLiveToolCallEvidence — free positive evidence, no HTTP spent", () => {
  it("records {ok:true} from a real turn's structured tool call without any fetch", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);

    noteLiveToolCallEvidence(BASE, "evidence-live");

    expect(f).not.toHaveBeenCalled();
    expect(getToolsVerified(BASE, "evidence-live")?.ok).toBe(true);
  });

  it("supersedes a stale advisory {ok:false} — live evidence wins", () => {
    recordToolsVerified(BASE, "healed-live", false);

    noteLiveToolCallEvidence(BASE, "healed-live");

    expect(getToolsVerified(BASE, "healed-live")?.ok).toBe(true);
  });

  it("records nothing for a non-loopback endpoint", () => {
    noteLiveToolCallEvidence("http://192.168.1.50:1234/v1", "lan-evidence-live");
    noteLiveToolCallEvidence("https://api.example-frontier.test/v1", "cloud-evidence-live");

    expect(getToolsVerified("http://192.168.1.50:1234/v1", "lan-evidence-live")).toBeUndefined();
    expect(getToolsVerified("https://api.example-frontier.test/v1", "cloud-evidence-live")).toBeUndefined();
  });
});
