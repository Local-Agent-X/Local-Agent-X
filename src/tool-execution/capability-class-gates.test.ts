// Capability-class re-keying — proves the security gates key on CAPABILITY
// CLASS, not literal canonical tool names. The master defect was that the
// ari_* bridge tools and other synonyms (email_send, browser, clipboard_write,
// process_start, ari_file, email_read, memory_search) are the same I/O sinks
// under names no gate recognized, so they bypassed egress / sensitive-read /
// worktree enforcement. These tests assert that synonyms are now enforced
// identically to their canonical equivalents.

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataLineageGate, egressGuardGate, canaryEgressGate } from "./enforce-policy.js";
import { hasCapability, WORKTREE_PATH_TOOLS, CAPABILITY_CLASS_MEMBERS, TOOLS } from "../tool-registry.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import { getAllTools } from "../tools/registry-build.js";
import { WORKTREE_REQUIRED_TOOLS } from "../security/types.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage.js";
import { scanForSecrets } from "../security/secret-scanner.js";
import { registerRedactedSecretValue, unregisterRedactedSecretValue } from "../security/known-secrets.js";
import { generateCanaries, registerSessionCanaries, clearSessionCanaries, _setCanaryAuditTrail } from "../threat/canaries.js";
import { CryptoAuditTrail } from "../threat/audit-trail.js";
import type { ToolCallContext } from "./context.js";

function makeCtx(name: string, args: Record<string, unknown>, sessionId: string): ToolCallContext {
  return {
    tc: { id: "1", name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: undefined as never,
    sessionId,
    callContext: "local",
    args,
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [],
  } as ToolCallContext;
}

describe("capability-class membership (single source of truth)", () => {
  it("egress class covers canonical http AND every synonym", () => {
    for (const t of ["http_request", "web_fetch", "ari_http", "email_send", "clipboard_write", "process_start", "browser", "browser_navigate"]) {
      expect(hasCapability(t, "egress")).toBe(true);
    }
    // vault-only browser sub-tools are NOT egress (value never enters context).
    expect(hasCapability("browser_fill_from_secret", "egress")).toBe(false);
    expect(hasCapability("read", "egress")).toBe(false);
  });

  it("sensitive-read class covers canonical AND synonyms", () => {
    for (const t of ["read", "bash", "sql_query", "ari_file", "email_read", "memory_search", "grep", "glob", "ari_retrieval", "ari_database", "ari_sqlite"]) {
      expect(hasCapability(t, "sensitive-read")).toBe(true);
    }
    expect(hasCapability("http_request", "sensitive-read")).toBe(false);
  });

  it("worktree path tools + WORKTREE_REQUIRED include ari_file", () => {
    expect(WORKTREE_PATH_TOOLS.has("ari_file")).toBe(true);
    for (const t of ["read", "write", "edit", "glob", "grep"]) expect(WORKTREE_PATH_TOOLS.has(t)).toBe(true);
    // WORKTREE_REQUIRED_TOOLS: canonical preserved + synonyms added.
    for (const t of ["write", "edit", "bash", "ari_file", "ari_shell", "process_start"]) {
      expect(WORKTREE_REQUIRED_TOOLS.has(t)).toBe(true);
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

describe("egressGuardGate — outbound secret scan + sensitive attachment (every egress sink)", () => {
  const sessionId = "cap-class-egress-guard";
  // A clearly secret-shaped value (AWS Access Key: AKIA + 16 upper/digit chars).
  const SECRET = "AKIA0000000000000000";

  it("blocks a hardcoded secret in clipboard_write content", () => {
    const ctx = makeCtx("clipboard_write", { text: `token=${SECRET}` }, sessionId);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.layer).toBe("egress-guard");
  });

  it("blocks a hardcoded secret in process_start command/args", () => {
    const ctx = makeCtx("process_start", { command: "deploy", args: [`--key=${SECRET}`] }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("halt");
  });

  it("blocks a hardcoded secret in an email_send body", () => {
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `here: ${SECRET}` }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("halt");
  });

  it("lets a clean payload through, and passes {{SECRET_NAME}} placeholders", () => {
    expect(egressGuardGate(makeCtx("clipboard_write", { text: "hello world" }, sessionId)).kind).toBe("continue");
    expect(egressGuardGate(makeCtx("email_send", { to: "a@b.com", subject: "x", body: "use {{API_KEY}}" }, sessionId)).kind).toBe("continue");
  });

  it("rejects email_send attaching a sensitive file path", () => {
    const ctx = makeCtx("email_send", {
      to: "a@b.com", subject: "x", body: "see attached",
      attachments: JSON.stringify(["~/.ssh/id_rsa", "/tmp/notes.txt"]),
    }, sessionId);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.blocked_by).toBe("sensitive-attachment");
  });

  it("allows email_send with a benign attachment", () => {
    const ctx = makeCtx("email_send", {
      to: "a@b.com", subject: "x", body: "see attached",
      attachments: JSON.stringify(["/tmp/report.pdf"]),
    }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("continue");
  });

  it("is a no-op for non-egress tools", () => {
    expect(egressGuardGate(makeCtx("read", { path: "/tmp/x" }, sessionId)).kind).toBe("continue");
  });
});

describe("egressGuardGate — known-secret-value (the user's ACTUAL stored secret)", () => {
  const sessionId = "cap-class-known-value";
  // A long, isSecretShaped but DELIBERATELY low-entropy readable value — it
  // matches no credential pattern AND no entropy run, so on its own the scan is
  // clean. The ONLY reason the guard can block it is that it's a REGISTERED
  // known secret value (eager-populated from the SecretsStore on load).
  const STORED = "right-pony-cylinder-marble-secret-value";

  beforeAll(() => registerRedactedSecretValue(STORED));
  afterAll(() => unregisterRedactedSecretValue(STORED));

  it("the value matches no pattern on its own — proving the block comes from the registry", () => {
    unregisterRedactedSecretValue(STORED);
    expect(scanForSecrets(`x=${STORED}`).clean).toBe(true);
    registerRedactedSecretValue(STORED);
    expect(scanForSecrets(`x=${STORED}`).clean).toBe(false);
  });

  it("blocks egress of the stored value literally", () => {
    const ctx = makeCtx("clipboard_write", { text: `copy ${STORED}` }, sessionId);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.layer).toBe("egress-guard");
  });

  it("blocks egress of the stored value base64-encoded (decode-view reuse)", () => {
    const blob = Buffer.from(STORED, "utf8").toString("base64");
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `data=${blob}` }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("halt");
  });
});

describe("canaryEgressGate — canary in an outbound payload is hard-blocked + audited", () => {
  const sessionId = "cap-class-canary";
  const canaries = generateCanaries();
  const CANARY = canaries[0]; // e.g. CANARY-<id>-ALPHA
  let auditDir: string;

  beforeEach(() => {
    // Arm the session's canary set (as ThreatEngine does), and inject a temp
    // audit trail so the exfil event can be read back without touching ~/.lax.
    registerSessionCanaries(sessionId, canaries);
    auditDir = mkdtempSync(join(tmpdir(), "lax-canary-audit-"));
    _setCanaryAuditTrail(new CryptoAuditTrail(auditDir));
  });
  afterAll(() => {
    clearSessionCanaries(sessionId);
    _setCanaryAuditTrail(null);
  });

  function auditPath(): string {
    const dir = join(auditDir, "audit");
    const files = readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"));
    return join(dir, files[0]);
  }

  it("hard-blocks an egress-class call whose payload contains a canary, and audits it WITHOUT the raw token", () => {
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `leaked: ${CANARY}` }, sessionId);
    const outcome = canaryEgressGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.metadata?.layer).toBe("canary");
    // Model-visible block text must NOT echo the raw canary value.
    expect(ctx.result?.content).not.toContain(CANARY);

    // A canary_exfil_detected event is appended and the chain verifies.
    const raw = readFileSync(auditPath(), "utf-8").trim();
    expect(raw).toContain("canary_exfil_detected");
    expect(raw).toContain("email_send");
    expect(raw).toContain('"controlsApplied":["Canary"]');
    // The raw canary token must NEVER appear in the audit record.
    expect(raw).not.toContain(CANARY);
    expect(CryptoAuditTrail.verify(auditPath()).valid).toBe(true);
  });

  it("blocks the base64-encoded form of the canary (decode-view reuse)", () => {
    const blob = Buffer.from(CANARY, "utf8").toString("base64");
    const ctx = makeCtx("clipboard_write", { text: `copy ${blob}` }, sessionId);
    expect(canaryEgressGate(ctx).kind).toBe("halt");
    expect(ctx.result?.metadata?.layer).toBe("canary");
  });

  it("does NOT block an egress payload with no canary (taint behavior unchanged)", () => {
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: "nothing secret here" }, sessionId);
    expect(canaryEgressGate(ctx).kind).toBe("continue");
  });

  it("is a no-op for non-egress tools even if the payload would contain a canary", () => {
    const ctx = makeCtx("read", { path: `/tmp/${CANARY}` }, sessionId);
    expect(canaryEgressGate(ctx).kind).toBe("continue");
  });

  it("does not fire for a session with no registered canaries", () => {
    const clean = "cap-class-canary-none";
    clearSessionCanaries(clean);
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `leaked: ${CANARY}` }, clean);
    expect(canaryEgressGate(ctx).kind).toBe("continue");
  });
});
