/**
 * Issue 11 — boundary-audit (PRD §22 Definition of Done).
 * docs/issues/canonical-loop/11-v1-hardening-and-invariants.md
 *
 * Static-import audits — fail fast if anyone introduces a forbidden
 * dependency that would erode the canonical-loop boundary contract.
 *
 *   - Loop modules (`src/canonical-loop/*.ts`, NOT including
 *     `adapters/`) must NOT import `child_process` / `node:child_process`,
 *     except the canonical process execution backend. Provider I/O remains
 *     behind the adapter contract and the child re-enters the same worker.
 *   - Loop modules must NOT import `ops/event-log` for
 *     write-side effects. Reads are allowed (e.g., `event-log.opDir`
 *     for filesystem layout).
 *   - Adapter source files (`src/canonical-loop/adapters/*.ts`) must
 *     NOT import any forbidden module from `FORBIDDEN_ADAPTER_IMPORTS`
 *     (PRD §15 sandbox). Exception: the transport-layer file
 *     `anthropic-transport.ts` lives outside the audited adapter
 *     surface — it sits behind the `AnthropicTransport` interface and
 *     is allowed to import the legacy provider client. The audit
 *     enforces this exception explicitly.
 *
 * The audit is a regex-based source scan; transitive imports are not
 * flagged (intentional — the canonical-loop's compile-time boundary is
 * declared by direct imports). Each import SPECIFIER, however, is matched
 * by MODULE IDENTITY, not substring: relative specifiers are resolved
 * against the importing file's directory and compared src/-relative, so a
 * relative spelling (`"../store.js"` from inside adapters/) is the same
 * violation as an explicit `"canonical-loop/store.js"` one (C19 — the old
 * substring matcher missed every relative form). Violations that pre-date
 * the identity matcher are grandfathered in `ADAPTER_AUDIT_BASELINE`
 * below — explicit, bounded, and shrink-only.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { FORBIDDEN_ADAPTER_IMPORTS } from "../src/canonical-loop/adapter-contract.js";

const SRC_DIR = join(process.cwd(), "src");
const LOOP_DIR = join(SRC_DIR, "canonical-loop");
const ADAPTERS_DIR = join(LOOP_DIR, "adapters");

/** Subprocess-spawning modules forbidden inside any canonical-loop file. */
const FORBIDDEN_LOOP_IMPORTS: readonly string[] = [
  "node:child_process",
  "child_process",
] as const;

/**
 * Adapter-file allow-list for transitive provider-client modules. Files
 * NOT on this list — anthropic.ts, future codex.ts etc. — are audited
 * against `FORBIDDEN_ADAPTER_IMPORTS`. Files on this list are the
 * intentional "transport boundary" and may use any module the legacy
 * provider client needs.
 */
const ADAPTER_TRANSPORT_ALLOWLIST: readonly string[] = [
  "anthropic-transport.ts",
] as const;
const PROCESS_BACKEND_ALLOWLIST: readonly string[] = [
  "process-execution-backend.ts",
] as const;

/**
 * Violations that pre-date the identity-resolving matcher (C19, 2026-09-02)
 * and were invisible to the substring matcher it replaced. Grandfathered in
 * the same explicit-bounded-allowlist style as the transport exemption:
 * each entry names ONE file (basename inside adapters/) and the ONE
 * forbidden module it imports. The scan also asserts every entry still
 * matches — fix the import and the stale entry fails the suite, so this
 * list can only shrink. NEVER add to it; new code must satisfy the audit.
 */
const ADAPTER_AUDIT_BASELINE: readonly { file: string; module: string }[] = [
  // Contract test seeds op messages straight through the canonical store
  // ("../store.js"); the adapter runtime under test stays clean.
  { file: "image-only-nudge.contract.test.ts", module: "canonical-loop/store" },
] as const;

function listTsFiles(dir: string, recurse = true): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (recurse) out.push(...listTsFiles(full, recurse));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function readSource(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Every import/export/require specifier in a TS source, static or dynamic. */
const SPECIFIER_RE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g;

/** Strip a resolvable source extension so "store.js" and "store.ts" compare equal. */
function stripSourceExt(p: string): string {
  return p.replace(/\.(?:js|ts|mjs|cjs|mts|cts)$/, "");
}

/**
 * Module identity of an import specifier as seen from `file`. Relative
 * specifiers resolve against the importing file's directory and come back
 * src/-relative with posix separators ("canonical-loop/store"); bare
 * specifiers (node builtins, packages) pass through untouched.
 */
function moduleIdentity(spec: string, file: string): string {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return relative(SRC_DIR, resolve(dirname(file), spec)).split(sep).join("/");
  }
  return spec;
}

interface ForbiddenHit {
  specifier: string;
  module: string;
  line: number;
}

/**
 * C19: the previous matcher tested forbidden names as SUBSTRINGS of the raw
 * import statement, so `"../store.js"` from inside adapters/ never contained
 * "canonical-loop/store" and evaded the audit. Identity comparison closes
 * that: every specifier is resolved against the importing file and compared
 * as a whole module id — never a substring.
 */
function findForbiddenImports(file: string, src: string, forbidden: readonly string[]): ForbiddenHit[] {
  const banned = new Set(forbidden.map(stripSourceExt));
  const hits: ForbiddenHit[] = [];
  for (const match of src.matchAll(SPECIFIER_RE)) {
    const identity = stripSourceExt(moduleIdentity(match[1], file));
    if (banned.has(identity)) {
      hits.push({
        specifier: match[1],
        module: identity,
        line: src.slice(0, match.index).split("\n").length,
      });
    }
  }
  return hits;
}

// ── Matcher self-test: identity resolution, or the audit is theater ─────

describe("Issue 11 — boundary audit matcher resolves module identity", () => {
  const adapterFile = join(ADAPTERS_DIR, "example.ts");

  it("catches relative, deep-relative, dynamic, require, and bare spellings", () => {
    const src = [
      'import { appendCanonicalEvent } from "../store.js";',
      'import { readOp } from "../../ops/op-store.js";',
      'const log = await import("../../ops/event-log.js");',
      'import { spawn } from "node:child_process";',
      'require("child_process");',
      'export { seed } from "../store.js";',
    ].join("\n");
    const hits = findForbiddenImports(adapterFile, src, FORBIDDEN_ADAPTER_IMPORTS);
    expect(hits.map(h => `${h.line}:${h.module}`)).toEqual([
      "1:canonical-loop/store",
      "2:ops/op-store",
      "3:ops/event-log",
      "4:node:child_process",
      "5:child_process",
      "6:canonical-loop/store",
    ]);
  });

  it("does not flag near-miss identities that merely share name fragments", () => {
    const src = [
      'import { getToolsVerified } from "../../providers/model-capabilities-store.js";',
      'import { readTurnArtifact } from "../turn-commit-store.js";',
      'import Anthropic from "@anthropic-ai/sdk";',
      'import { opDir } from "../../ops/event-log-shim.js";',
    ].join("\n");
    expect(findForbiddenImports(adapterFile, src, FORBIDDEN_ADAPTER_IMPORTS)).toEqual([]);
  });
});

// ── Loop modules: no subprocess imports ─────────────────────────────────

describe("Issue 11 — boundary audit: loop modules have no subprocess imports", () => {
  it("only the process execution backend imports child_process", () => {
    const files = listTsFiles(LOOP_DIR, true);
    expect(files.length).toBeGreaterThan(0);
    const violations: { file: string; hits: ForbiddenHit[] }[] = [];
    for (const file of files) {
      // Adapter transport files are exempt — they sit behind the adapter
      // contract and may bridge to legacy provider clients which DO use
      // subprocess primitives. The adapter source itself (audited
      // separately) must remain clean.
      const base = file.replace(/\\/g, "/");
      const isAdapterTransport = ADAPTER_TRANSPORT_ALLOWLIST.some(name =>
        base.endsWith(`/canonical-loop/adapters/${name}`),
      );
      const isProcessBackend = PROCESS_BACKEND_ALLOWLIST.some(name =>
        base.endsWith(`/canonical-loop/${name}`),
      );
      if (isAdapterTransport || isProcessBackend) continue;
      const hits = findForbiddenImports(file, readSource(file), FORBIDDEN_LOOP_IMPORTS);
      if (hits.length > 0) violations.push({ file, hits });
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

// ── Adapter modules: PRD §15 sandbox enforced statically ────────────────

describe("Issue 11 — boundary audit: adapter sandbox imports", () => {
  it("each non-transport adapter source imports nothing on FORBIDDEN_ADAPTER_IMPORTS", () => {
    const adapterFiles = listTsFiles(ADAPTERS_DIR, false);
    expect(adapterFiles.length).toBeGreaterThan(0);
    const violations: { file: string; hits: ForbiddenHit[] }[] = [];
    const matchedBaseline = new Set<string>();
    for (const file of adapterFiles) {
      const isTransport = ADAPTER_TRANSPORT_ALLOWLIST.some(name => file.endsWith(name));
      if (isTransport) continue;
      const norm = file.replace(/\\/g, "/");
      const hits = findForbiddenImports(file, readSource(file), FORBIDDEN_ADAPTER_IMPORTS);
      const standing = hits.filter(hit => {
        const grandfathered = ADAPTER_AUDIT_BASELINE.find(
          b => norm.endsWith(`/${b.file}`) && b.module === hit.module,
        );
        if (grandfathered) matchedBaseline.add(`${grandfathered.file} → ${grandfathered.module}`);
        return !grandfathered;
      });
      if (standing.length > 0) violations.push({ file, hits: standing });
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    // Stale-baseline guard: an entry whose violation is gone must be deleted,
    // so the grandfather list can only shrink — never silently over-exempt.
    const stale = ADAPTER_AUDIT_BASELINE
      .map(b => `${b.file} → ${b.module}`)
      .filter(key => !matchedBaseline.has(key));
    expect(stale, `baseline entries no longer matched — remove them:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("FORBIDDEN_ADAPTER_IMPORTS still names the v1 sandbox set", () => {
    // Locked-set guard: if anyone adds/removes from the sandbox list, this
    // test fails — forces the change to be a deliberate breaking edit
    // rather than silent drift.
    expect([...FORBIDDEN_ADAPTER_IMPORTS]).toEqual([
      "canonical-loop/store",
      "canonical-loop/store.js",
      "ops/op-store",
      "ops/op-store.js",
      "ops/event-log",
      "ops/event-log.js",
      "node:child_process",
      "child_process",
    ]);
  });
});

// ── Permitted exception: anthropic-transport.ts is allowed to bridge ────

describe("Issue 11 — adapter transport allow-list is bounded", () => {
  it("only `anthropic-transport.ts` is exempted from the adapter sandbox audit", () => {
    expect([...ADAPTER_TRANSPORT_ALLOWLIST]).toEqual(["anthropic-transport.ts"]);
  });

  it("the adapter-audit grandfather baseline is bounded", () => {
    expect(ADAPTER_AUDIT_BASELINE.map(b => `${b.file} → ${b.module}`)).toEqual([
      "image-only-nudge.contract.test.ts → canonical-loop/store",
    ]);
  });

  it("the audited adapter (anthropic.ts) does NOT import child_process even directly", () => {
    const anthropicFile = join(ADAPTERS_DIR, "anthropic.ts");
    const hits = findForbiddenImports(anthropicFile, readSource(anthropicFile), [
      "child_process",
      "node:child_process",
    ]);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});
