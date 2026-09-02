// Capability-class re-keying — proves the security gates key on CAPABILITY
// CLASS, not literal canonical tool names. The master defect was that the
// ari_* bridge tools and other synonyms (email_send, browser, clipboard_write,
// process_start, ari_file, email_read, memory_search) are the same I/O sinks
// under names no gate recognized, so they bypassed egress / sensitive-read /
// worktree enforcement. These tests assert that synonyms are now enforced
// identically to their canonical equivalents.

// The egressGuardGate/canaryEgressGate payload suites (secret scan, attachment
// TOCTOU, known-secret-value registry, canary audit) live in
// capability-class-egress-scan.test.ts (split for the 400-LOC gate).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataLineageGate, egressGuardGate, canaryEgressGate } from "./enforce-policy.js";
import { hasCapability, WORKTREE_PATH_TOOLS, CAPABILITY_CLASS_MEMBERS, TOOLS, validateCapabilitySets } from "../tool-registry.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import { getAllTools } from "../tools/registry-build.js";
import { WORKTREE_REQUIRED_TOOLS } from "../security/layer/index.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage/index.js";
import { scanForSecrets } from "../security/secrets/index.js";
import { checkAttachmentPaths } from "../tools/http-egress-guard.js";
import { generateCanaries, registerSessionCanaries, clearSessionCanaries, checkCanariesInPayload } from "../threat/canaries.js";
import { makeCtx } from "./capability-class-gates.test-helper.js";

describe("capability-class membership (single source of truth)", () => {
  it("egress class covers canonical http AND every synonym", () => {
    for (const t of ["http_request", "web_fetch", "ari_http", "email_send", "clipboard_write", "process_start", "process_restart", "browser", "browser_navigate"]) {
      expect(hasCapability(t, "egress")).toBe(true);
    }
    // vault-only browser sub-tools are NOT egress (value never enters context).
    expect(hasCapability("browser_fill_from_secret", "egress")).toBe(false);
    expect(hasCapability("read", "egress")).toBe(false);
  });

  it("view_image is egress — its base64 image bytes ship off-box to the vision API (R4-20)", () => {
    // Out of EGRESS_TOOLS, egressGuardGate/dataLineageGate/canaryEgressGate all
    // early-return CONTINUE, so the image bytes never hit the secret/canary scan
    // or the sensitive-attachment (path) check. Membership enrolls them.
    expect(hasCapability("view_image", "egress")).toBe(true);
  });

  it("sensitive-read class covers canonical AND synonyms", () => {
    for (const t of ["read", "bash", "sql_query", "ari_file", "email_read", "memory_search", "grep", "glob", "ari_retrieval", "ari_database", "ari_sqlite"]) {
      expect(hasCapability(t, "sensitive-read")).toBe(true);
    }
    expect(hasCapability("http_request", "sensitive-read")).toBe(false);
  });

  it("no tool is BOTH egress and sensitive-read (gate-atomicity invariant, R4-09)", () => {
    // A tool that is both could self-race within its own pipeline: its egress
    // check (policy phase) runs before its taint floor-set (sandbox phase), so
    // the floor it sets could never gate its own egress. validateCapabilitySets
    // throws on violation; assert the sets are disjoint directly too so a
    // regression names the offending tool.
    const egress = new Set(CAPABILITY_CLASS_MEMBERS.egress);
    const both = CAPABILITY_CLASS_MEMBERS["sensitive-read"].filter((t) => egress.has(t));
    expect(both, `tools that are BOTH egress and sensitive-read: ${both.join(", ")}`).toEqual([]);
    expect(() => validateCapabilitySets()).not.toThrow();
  });

  it("workspace-write class covers canonical AND the registered edit/delete synonyms", () => {
    // edit_lines / multi_edit / delete_file share write/edit's blast radius
    // (the same family resolve-tool's protected-files gate keys on). Left out
    // of the class, a workspace-write ban (op ledger or enforced plan mode)
    // blocked `edit` but not `edit_lines` — fail-open under another spelling.
    for (const t of ["write", "edit", "ari_file", "edit_lines", "multi_edit", "delete_file"]) {
      expect(hasCapability(t, "workspace-write")).toBe(true);
    }
    expect(hasCapability("read", "workspace-write")).toBe(false);
  });

  it("worktree path tools + WORKTREE_REQUIRED include ari_file", () => {
    expect(WORKTREE_PATH_TOOLS.has("ari_file")).toBe(true);
    for (const t of ["read", "write", "edit", "glob", "grep"]) expect(WORKTREE_PATH_TOOLS.has(t)).toBe(true);
    // WORKTREE_REQUIRED_TOOLS: canonical preserved + synonyms added.
    for (const t of ["write", "edit", "bash", "ari_file", "ari_shell", "process_start", "process_restart", "app_serve_backend", "app_serve_frontend"]) {
      expect(WORKTREE_REQUIRED_TOOLS.has(t)).toBe(true);
    }
  });

  it("shell class covers every canonical shell-exec backend", () => {
    for (const t of ["bash", "shell", "ari_shell", "process_start", "process_restart", "app_serve_backend", "app_serve_frontend"]) {
      expect(hasCapability(t, "shell"), t).toBe(true);
    }
  });
});

describe("name-drift guard — every capability-set member resolves to a real tool", () => {
  // The ROOT cause behind H1/L1 (egress sinks left OUT of EGRESS_TOOLS → gates
  // fail OPEN) and L2 (ari_sqlite_database vs ari_sqlite → policy projection
  // fails CLOSED) is silent NAME DRIFT: a capability set names a tool the
  // registry doesn't know, or the registry renames a tool and a set is left
  // stale. This test makes either direction a build failure.
  //
  // Canonical name authority = the unified policy table (TOOL_POLICIES). Every
  // concrete tool the kernel/security pipeline knows about is a key there
  // (deriveTools → TOOLS); the ari_* kernel-bridge synonyms live there too.
  // (getAllTools() is only the statically-bundled core — agent_*/memory_*/
  // mission_*/app_*/browser etc. are registered through runtime/bridge paths —
  // so it is NOT the right ground truth; the policy table is.)
  const POLICY_KEYS = new Set(Object.keys(TOOL_POLICIES));

  // Bare model-synonyms that are intentionally NOT policy-table keys: the loop's
  // tool-call text-extractor maps these aliases onto a real sink at dispatch,
  // and the capability sets list them so the alias is gated like its canonical.
  // Whitelist them EXPLICITLY — kept minimal and justified — so a genuinely
  // drifted name (e.g. a typo'd egress tool) still fails.
  const SYNONYM_ALIASES = new Set<string>([
    "shell", // model alias for `bash` (canonical-loop/adapters/tool-call-text-extractor.ts)
  ]);

  function isResolvable(name: string): boolean {
    if (POLICY_KEYS.has(name)) return true;
    if (SYNONYM_ALIASES.has(name)) return true;
    // browser_* sub-actions are gated by prefix (hasCapability) and dispatched
    // through the `browser` tool (a policy key); the two vault sub-tools have
    // their own policy entries.
    if (name.startsWith("browser_")) return true;
    return false;
  }

  it("every capability-class member resolves to a policy-table tool or whitelisted synonym", () => {
    const orphans: string[] = [];
    for (const [cls, members] of Object.entries(CAPABILITY_CLASS_MEMBERS)) {
      for (const name of members) {
        if (!isResolvable(name)) orphans.push(`${cls}:${name}`);
      }
    }
    expect(orphans, `capability-set members with no resolvable tool: ${orphans.join(", ")}`).toEqual([]);
  });

  it("ari_sqlite is the canonical SQLite-bridge spelling (regression: NOT ari_sqlite_database)", () => {
    // Direct teeth for L2: registry/bridge/resolve-tool all spell it ari_sqlite;
    // the policy table must agree or every ari_sqlite call fails closed.
    expect(POLICY_KEYS.has("ari_sqlite")).toBe(true);
    expect(POLICY_KEYS.has("ari_sqlite_database")).toBe(false);
    expect(TOOLS.ari_sqlite).toBeDefined();
    expect(hasCapability("ari_sqlite", "sensitive-read")).toBe(true);
  });

  it("the two HTTP-GET sinks left out of EGRESS_TOOLS are now egress AND registered (regression: H1/L1)", () => {
    expect(hasCapability("extract_site_assets", "egress")).toBe(true);
    expect(hasCapability("youtube_analyze", "egress")).toBe(true);
    // They are real, statically-registered tools (not just policy rows).
    const registered = new Set(getAllTools().map(t => t.name));
    expect(registered.has("extract_site_assets")).toBe(true);
    expect(registered.has("youtube_analyze")).toBe(true);
  });

  it("every off-box-fetch tool (policy.offBoxFetch) is enrolled in EGRESS_TOOLS (regression: C3-4/C3-11/C3-22)", () => {
    // The egress capability class is hand-maintained; an off-box network sink
    // left OUT of it skips the taint floor, secret scan, AND the canary
    // tripwire (the three gates early-return CONTINUE for non-members). This
    // invariant ties the class to the per-tool `offBoxFetch` mark so marking a
    // tool off-box but forgetting to enroll it FAILS the build instead of
    // silently re-opening the exfil channel.
    const egress = new Set(CAPABILITY_CLASS_MEMBERS.egress);
    const offBox = Object.entries(TOOL_POLICIES)
      .filter(([, entry]) => entry.offBoxFetch === true)
      .map(([name]) => name);
    // Sanity: the four R3 sinks are actually marked (guards against a silent
    // empty filter that would make the assertion vacuously pass).
    for (const t of ["web_search", "generate_image", "generate_video", "send_video"]) {
      expect(offBox, `${t} must carry offBoxFetch:true in the policy table`).toContain(t);
    }
    const unenrolled = offBox.filter(name => !egress.has(name));
    expect(unenrolled, `offBoxFetch tools missing from EGRESS_TOOLS: ${unenrolled.join(", ")}`).toEqual([]);
  });

  it("every tool whose OUTPUT the bridge forwards off-box (_image/_media) is egress-class (regression: R4-12b)", () => {
    // The bridge forward loop (server/bootstrap-bridges.ts) ships a tool's
    // RESULT bytes off-box: it forwards any tool result carrying images[] (an
    // `_image` emitter) via sendImage/sendPhoto, and any result.media.kind ===
    // "video" (a `_media` emitter) via sendVideo. Those forwarded bytes are
    // re-scanned in the loop, but the scan only fires for EGRESS-class tools
    // (the loop reuses the egress secret/canary/attachment helpers). So EVERY
    // media-emitting tool must be egress-class — a NEW image/video emitter that
    // isn't enrolled would have its output forwarded UNSCANNED. Enumerated here
    // so dropping one (or adding an unenrolled emitter) fails CI.
    const MEDIA_EMITTERS = [
      "view_image", "screen_capture", "camera_capture", // emit images[]
      "generate_image",                                  // emits images[]
      "generate_video", "send_video",                    // emit media.{kind:"video",path}
      "send_image",                                      // emits media.{kind:"image",path}
    ];
    for (const t of MEDIA_EMITTERS) {
      expect(hasCapability(t, "egress"), `${t} forwards output bytes off-box via the bridge but is NOT egress-class — its forwarded output would skip the secret/canary/attachment scan`).toBe(true);
    }
  });
});

describe("dataLineageGate keys on egress class (not just http_request)", () => {
  const sessionId = "cap-class-taint";
  beforeEach(() => {
    clearSessionTaint(sessionId);
    // Arm the gate: a sensitive read occurred this session.
    recordSensitiveRead(sessionId, "sensitive_file", "/Users/x/.ssh/id_rsa");
  });

  it("blocks ALL egress-class sinks when the session is tainted", () => {
    for (const name of ["http_request", "ari_http", "email_send", "clipboard_write", "process_start", "browser_navigate"]) {
      const ctx = makeCtx(name, {}, sessionId);
      const outcome = dataLineageGate(ctx);
      expect(outcome.kind).toBe("halt");
      expect(ctx.allowed).toBe(false);
      expect(ctx.result?.metadata?.layer).toBe("data-lineage");
    }
  });

  it("does NOT block non-egress sinks even when tainted", () => {
    const ctx = makeCtx("read", { path: "/tmp/x" }, sessionId);
    expect(dataLineageGate(ctx).kind).toBe("continue");
  });

  it("does NOT block egress when the session is clean (untainted)", () => {
    const clean = "cap-class-clean";
    clearSessionTaint(clean);
    const ctx = makeCtx("email_send", { to: "a@b.com", body: "hi" }, clean);
    expect(dataLineageGate(ctx).kind).toBe("continue");
  });
});

describe("computer (key_type) is egress — typed text gated, mouse actions exempt", () => {
  // The `computer` tool can TYPE model-authored text into another app, so a
  // secret it read could be exfiltrated through the keyboard. It is egress-class
  // so the secret-scan + canary + taint gates cover the typed text — but ONLY
  // the text: a mouse move/click carries no data and must never be false-blocked.
  const SECRET = "AKIA0000000000000000"; // AWS-key-shaped
  const canaries = generateCanaries();
  const CANARY = canaries[0];

  it("is enrolled in the egress capability class", () => {
    expect(hasCapability("computer", "egress")).toBe(true);
  });

  it("egressGuardGate blocks a secret typed via action:type, but is a no-op for a mouse move", () => {
    const sid = "cap-class-computer-secret";
    expect(egressGuardGate(makeCtx("computer", { action: "type", text: `pw=${SECRET}` }, sid)).kind).toBe("halt");
    expect(egressGuardGate(makeCtx("computer", { action: "move", x: 100, y: 200 }, sid)).kind).toBe("continue");
    expect(egressGuardGate(makeCtx("computer", { action: "type", text: "hello world" }, sid)).kind).toBe("continue");
  });

  it("canaryEgressGate hard-blocks a canary typed via action:type", () => {
    const sid = "cap-class-computer-canary";
    registerSessionCanaries(sid, canaries);
    try {
      expect(canaryEgressGate(makeCtx("computer", { action: "type", text: `x ${CANARY}` }, sid)).kind).toBe("halt");
      expect(canaryEgressGate(makeCtx("computer", { action: "click", x: 5, y: 5 }, sid)).kind).toBe("continue");
    } finally {
      clearSessionCanaries(sid);
    }
  });

  it("dataLineageGate floors TYPING after a sensitive read, but lets the mouse keep moving", () => {
    const sid = "cap-class-computer-taint";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "sensitive_file", "/Users/x/.ssh/id_rsa");
    // Typing carries data → the presence floor applies (catches paraphrased
    // secrets the value-scan would miss).
    expect(dataLineageGate(makeCtx("computer", { action: "type", text: "anything" }, sid)).kind).toBe("halt");
    // Pointer actuation carries nothing → must NOT be blocked (no over-block).
    expect(dataLineageGate(makeCtx("computer", { action: "move", x: 1, y: 2 }, sid)).kind).toBe("continue");
    expect(dataLineageGate(makeCtx("computer", { action: "click", x: 1, y: 2 }, sid)).kind).toBe("continue");
    expect(dataLineageGate(makeCtx("computer", { action: "screen_size" }, sid)).kind).toBe("continue");
    clearSessionTaint(sid);
  });
});

describe("bridge OUTPUT-byte forward scan (R4-12b: the bytes shipped off-box re-enter a gate)", () => {
  // The bridge forward loop (server/bootstrap-bridges.ts) re-gates the RESULT
  // bytes it forwards off-box using the SAME helpers the egress gates use:
  //   - decoded image bytes → scanForSecrets + checkCanariesInPayload (block the
  //     item on a trip — catches a renamed text file / SVG-with-token shipped as
  //     an "image"),
  //   - video .media.path → checkAttachmentPaths (closes the path TOCTOU).
  // These tests pin the decision shape the loop depends on: a clean image passes,
  // a secret/canary-bearing one trips, and a sensitive video path is refused.
  const sessionId = "cap-class-forward";
  const canaries = generateCanaries();
  const CANARY = canaries[0];
  let tmp: string;

  beforeEach(() => {
    registerSessionCanaries(sessionId, canaries);
    tmp = mkdtempSync(join(tmpdir(), "lax-forward-"));
  });
  afterEach(() => {
    clearSessionCanaries(sessionId);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a benign decoded image (no secret, no canary) forwards", () => {
    const img = Buffer.from("this is a plain caption with no credentials at all");
    const view = img.toString("utf-8");
    expect(scanForSecrets(view).clean).toBe(true);
    expect(checkCanariesInPayload(sessionId, view)).toBeNull();
  });

  it("a renamed-text 'image' whose bytes are a secret trips the scan (blocked in the loop)", () => {
    const img = Buffer.from("not really an image\napi=sk-ant-api03-" + "A".repeat(80) + "\n");
    expect(scanForSecrets(img.toString("utf-8")).clean).toBe(false);
  });

  it("an 'image' whose bytes carry a session canary trips the canary check", () => {
    const img = Buffer.from(`<svg><text>${CANARY}</text></svg>`);
    expect(checkCanariesInPayload(sessionId, img.toString("utf-8"))).not.toBeNull();
  });

  it("a video path resolving to a secret-shaped file is refused by checkAttachmentPaths", () => {
    const vid = join(tmp, "clip.mp4");
    writeFileSync(vid, "-----BEGIN OPENSSH PRIVATE KEY-----\nnotreal\n");
    expect(checkAttachmentPaths("bridge:test video forward", [vid])).not.toBeNull();
  });

  it("a genuinely benign video path passes checkAttachmentPaths", () => {
    const vid = join(tmp, "ok.mp4");
    writeFileSync(vid, "\x00\x00\x00\x18ftypmp42 plain video bytes, no credentials\n");
    expect(checkAttachmentPaths("bridge:test video forward", [vid])).toBeNull();
  });

  // Regression: a benign binary image (PNG) decoded as utf-8 is high-entropy noise
  // that the secret scanner's entropy pass flagged as a key on EVERY attach —
  // false-blocking view_image / screen_capture / send_video / email-of-an-image.
  it("a binary image whose high-entropy bytes would trip the secret scanner is NOT blocked", () => {
    const entropyBlob = "Kp7QmXz9Lr4TnBv8Wy3HdFg1Js0AcRb6Ue2Yi4Op5Zx";
    // Sanity leg: as plain TEXT this run DOES trip the scanner — proving the binary
    // skip (not a benign payload) is what clears the image below.
    const asText = join(tmp, "leak.txt");
    writeFileSync(asText, `key=${entropyBlob}`);
    expect(checkAttachmentPaths("view_image", [asText])).not.toBeNull();

    // Same bytes inside a real binary image: PNG signature + IHDR length carry NUL
    // bytes in the head, so the file is detected as binary and the text scan skips.
    const png = join(tmp, "shot.png");
    writeFileSync(png, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
      Buffer.from(entropyBlob),
    ]));
    expect(checkAttachmentPaths("view_image", [png])).toBeNull();
  });
});
