import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  recordSensitiveRead,
  checkEgressTaint,
  clearSessionTaint,
  getKernelTaintSources,
  propagateTaint,
  findTaintInPayload,
  checkEgressTaintWithPayload,
} from "./index.js";
import { Handler } from "../agency/handler.js";

describe("content fingerprints + payload-overlap evidence (T1)", () => {
  const SESS = "fp-session";
  beforeEach(() => clearSessionTaint(SESS));
  afterEach(() => clearSessionTaint(SESS));

  // A chunk of secret content that's long enough to shingle and unlikely to
  // recur in unrelated prose.
  const SECRET_CONTENT =
    "BEGIN PRIVATE BLOB: super-secret-payload-marker-7f3a9c1e-quux-zonk-data END";

  it("a content read carries fingerprints; findTaintInPayload detects a chunk of that exact content", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    // A payload that quotes a CHUNK (not the whole blob) of the tainted content.
    const payload = `Here is some data: super-secret-payload-marker-7f3a9c1e-quux-zonk-data — done.`;
    const hits = findTaintInPayload(SESS, payload);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe("sensitive_file");
    expect(hits[0].target).toBe("/home/u/.ssh/id_rsa");
  });

  it("detects a base64-encoded form of the tainted content (decode-view reuse)", () => {
    recordSensitiveRead(SESS, "secret", "bash:blob", SECRET_CONTENT);
    const b64 = Buffer.from(SECRET_CONTENT, "utf-8").toString("base64");
    const payload = `exfil attempt blob=${b64} trailing`;
    const hits = findTaintInPayload(SESS, payload);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].target).toBe("bash:blob");
  });

  it("NEGATIVE: a payload with none of the tainted content returns []", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    const payload = "Completely unrelated quarterly sales prose about collagen and creatine demand.";
    expect(findTaintInPayload(SESS, payload)).toEqual([]);
  });

  it("NEGATIVE: a 3-arg read (no content) produces no fingerprint evidence", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa");
    // Even a payload echoing the target path yields no fingerprint hit (no content recorded).
    expect(findTaintInPayload(SESS, "/home/u/.ssh/id_rsa contents here")).toEqual([]);
  });

  it("checkEgressTaint still blocks a tainted session (presence floor unchanged)", () => {
    // No content at all → presence floor must still block.
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(checkEgressTaint(SESS).blocked).toBe(true);
  });

  it("checkEgressTaintWithPayload ALLOWS a fully-fingerprinted read when the payload overlaps nothing (Option B+ friction fix); evidence []", () => {
    // SECRET_CONTENT is short → fully fingerprinted AND complete → clearable.
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    const res = checkEgressTaintWithPayload(SESS, "totally benign outbound text");
    // Completeness guard satisfied + no overlap → egress may proceed.
    expect(res.blocked).toBe(false);
    // No content overlap → no evidence sources named.
    expect(res.evidence).toEqual([]);
  });

  it("checkEgressTaintWithPayload names the source when the payload carries tainted bytes", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    const payload = `POST body: super-secret-payload-marker-7f3a9c1e-quux-zonk-data`;
    const res = checkEgressTaintWithPayload(SESS, payload);
    expect(res.blocked).toBe(true);
    expect(res.evidence.length).toBeGreaterThan(0);
    expect(res.reason).toMatch(/payload contains bytes|id_rsa|sensitive_file/i);
  });

  it("a clean session never blocks regardless of payload content", () => {
    const res = checkEgressTaintWithPayload(SESS, "anything at all");
    expect(res.blocked).toBe(false);
    expect(res.evidence).toEqual([]);
  });

  it("no plaintext content is stored on the taint entry (fingerprints are hashes)", () => {
    recordSensitiveRead(SESS, "secret", "bash:blob", SECRET_CONTENT);
    // The overlap primitive works, proving fingerprints exist — but a serialized
    // view of the session's evidence path must never echo the plaintext content.
    const res = checkEgressTaintWithPayload(SESS, "benign");
    expect(JSON.stringify(res)).not.toContain("super-secret-payload-marker");
    // findTaintInPayload returns provenance only, never content.
    const hits = findTaintInPayload(SESS, SECRET_CONTENT);
    expect(JSON.stringify(hits)).not.toContain("super-secret-payload-marker");
  });
});
describe("getKernelTaintSources — LAX → kernel taint mapping", () => {
  it("returns [] for a clean session", () => {
    clearSessionTaint("clean-1");
    expect(getKernelTaintSources("clean-1")).toEqual([]);
  });

  it("maps web → web, memory → rag, sensitive_file/secret → rag, user_data → user-provided", () => {
    const sid = "map-1";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "http://x");
    recordSensitiveRead(sid, "memory", "note");
    recordSensitiveRead(sid, "sensitive_file", "/Users/x/.aws/credentials");
    recordSensitiveRead(sid, "secret", "bash:openai-key");
    recordSensitiveRead(sid, "user_data", "form-input");
    const sources = getKernelTaintSources(sid).sort();
    // web/memory/sensitive_file/secret all land in the kernel deny-set
    // (web/rag); user_data maps to user-provided (intentionally NOT denied).
    expect(sources).toEqual(["rag", "user-provided", "web"]);
    clearSessionTaint(sid);
  });

  it("web/rag sources are the ones the kernel deny-tainted-shell rule keys on", () => {
    const sid = "map-2";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "http://x");
    expect(getKernelTaintSources(sid)).toContain("web");
    clearSessionTaint(sid);
  });
});

describe("propagateTaint — parent ← child sub-agent propagation", () => {
  it("carries a child's sensitive read into the parent session", () => {
    const child = "agent-abc123";
    const parent = "chat-parent-1";
    clearSessionTaint(child);
    clearSessionTaint(parent);

    // Parent starts clean.
    expect(checkEgressTaint(parent).blocked).toBe(false);
    expect(getKernelTaintSources(parent)).toEqual([]);

    // Child reads a sensitive file.
    recordSensitiveRead(child, "sensitive_file", "/Users/x/.ssh/id_rsa");

    // Propagation (as fired at sub-agent completion) taints the parent.
    const moved = propagateTaint(child, parent);
    expect(moved).toBe(1);
    expect(checkEgressTaint(parent).blocked).toBe(true);
    // And the parent now hands the kernel non-empty taint on its next gated call.
    expect(getKernelTaintSources(parent)).toContain("rag");

    clearSessionTaint(child);
    clearSessionTaint(parent);
  });

  it("is a no-op when the child is clean", () => {
    const child = "agent-clean";
    const parent = "chat-parent-2";
    clearSessionTaint(child);
    clearSessionTaint(parent);
    expect(propagateTaint(child, parent)).toBe(0);
    expect(checkEgressTaint(parent).blocked).toBe(false);
  });

  it("does not propagate a session into itself", () => {
    const sid = "agent-self";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "http://x");
    expect(propagateTaint(sid, sid)).toBe(0);
    clearSessionTaint(sid);
  });
});

// Regression for finding H4 (HIGH): a sub-agent's tool calls record taint under
// `req.sessionId ?? agent-<id>` (handler-events.ts: runSessionId). The Handler's
// completion path (pushCompletionToParent) must propagate FROM that SAME bucket.
// Before the fix it re-derived `agent-<id>` unconditionally, so an
// operations-executor phase spawned with a BORROWED sessionId (`agent-op-<id>`)
// recorded taint under the borrowed id while propagation read an EMPTY
// `agent-<id>` map — orphaning the taint and leaving the parent CLEAN.
//
// We drive the real seam: attachExternalRun (storing the borrowed runSessionId) →
// record taint under that bucket → finalizeExternalRun (fires
// pushCompletionToParent) → assert the parent is now tainted.
describe("Handler completion → taint propagation from the child's ACTUAL session (H4)", () => {
  afterEach(() => {
    Handler.resetInstance();
  });

  it("propagates from a BORROWED sessionId (ops-phase) the child's tools recorded under", () => {
    const handler = Handler.getInstance();
    const parent = "chat-parent-h4-borrowed";
    const borrowed = "agent-op-OP123"; // what operations/executor passes as opts.sessionId
    clearSessionTaint(parent);
    clearSessionTaint(borrowed);

    // Spawn a phase agent the way invokeDefinition does: parent linkage + the
    // borrowed runtime session it will record taint under.
    const { agentId } = handler.attachExternalRun({
      name: "op-phase",
      role: "operator",
      task: "do a phase",
      parentSessionId: parent,
      runSessionId: borrowed,
    });
    clearSessionTaint(`agent-${agentId}`); // ensure the re-derived bucket is empty

    // Parent starts clean.
    expect(checkEgressTaint(parent).blocked).toBe(false);

    // The phase's tools read a sensitive file — recorded under the BORROWED id.
    recordSensitiveRead(borrowed, "sensitive_file", "/Users/x/.ssh/id_rsa", "ssh private key bytes here");

    // Completion fires pushCompletionToParent. Pre-fix this copied nothing
    // (read the empty `agent-<id>` bucket) and the parent stayed CLEAN.
    handler.finalizeExternalRun(agentId, { result: "phase done", success: true });

    expect(checkEgressTaint(parent).blocked).toBe(true);
    expect(getKernelTaintSources(parent)).toContain("rag");

    clearSessionTaint(parent);
    clearSessionTaint(borrowed);
  });

  it("still propagates in the DEFAULT case (no borrowed sessionId → agent-<id>)", () => {
    const handler = Handler.getInstance();
    const parent = "chat-parent-h4-default";
    clearSessionTaint(parent);

    // No runSessionId — the run uses its auto-minted `agent-<id>` tool session.
    const { agentId } = handler.attachExternalRun({
      name: "spawned",
      role: "researcher",
      task: "research",
      parentSessionId: parent,
    });
    const auto = `agent-${agentId}`;
    clearSessionTaint(auto);

    expect(checkEgressTaint(parent).blocked).toBe(false);

    // Child records taint under the default `agent-<id>` bucket.
    recordSensitiveRead(auto, "web", "https://internal.example/secret");

    handler.finalizeExternalRun(agentId, { result: "done", success: true });

    expect(checkEgressTaint(parent).blocked).toBe(true);
    expect(getKernelTaintSources(parent)).toContain("web");

    clearSessionTaint(parent);
    clearSessionTaint(auto);
  });
});
