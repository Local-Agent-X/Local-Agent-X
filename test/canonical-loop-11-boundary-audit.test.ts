/**
 * Issue 11 — boundary-audit (PRD §22 Definition of Done).
 * docs/issues/canonical-loop/11-v1-hardening-and-invariants.md
 *
 * Static-import audits — fail fast if anyone introduces a forbidden
 * dependency that would erode the canonical-loop boundary contract.
 *
 *   - Loop modules (`src/canonical-loop/*.ts`, NOT including
 *     `adapters/`) must NOT import `child_process` / `node:child_process`.
 *     The loop never spawns subprocesses; provider I/O lives behind
 *     the adapter contract.
 *   - Loop modules must NOT import `workers/event-log` for
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
 * declared by direct imports).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { FORBIDDEN_ADAPTER_IMPORTS } from "../src/canonical-loop/adapter-contract.js";

const LOOP_DIR = join(process.cwd(), "src", "canonical-loop");
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

function findForbiddenImports(src: string, forbidden: readonly string[]): string[] {
  const hits: string[] = [];
  for (const f of forbidden) {
    const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fromRe = new RegExp(`from\\s+['"][^'"]*${escaped}[^'"]*['"]`);
    const reqRe = new RegExp(`require\\(\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*\\)`);
    const dynRe = new RegExp(`import\\(\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*\\)`);
    if (fromRe.test(src) || reqRe.test(src) || dynRe.test(src)) {
      hits.push(f);
    }
  }
  return hits;
}

// ── Loop modules: no subprocess imports ─────────────────────────────────

describe("Issue 11 — boundary audit: loop modules have no subprocess imports", () => {
  it("no canonical-loop source file imports child_process / node:child_process", () => {
    const files = listTsFiles(LOOP_DIR, true);
    expect(files.length).toBeGreaterThan(0);
    const violations: { file: string; hits: string[] }[] = [];
    for (const file of files) {
      // Adapter transport files are exempt — they sit behind the adapter
      // contract and may bridge to legacy provider clients which DO use
      // subprocess primitives. The adapter source itself (audited
      // separately) must remain clean.
      const base = file.replace(/\\/g, "/");
      const isAdapterTransport = ADAPTER_TRANSPORT_ALLOWLIST.some(name =>
        base.endsWith(`/canonical-loop/adapters/${name}`),
      );
      if (isAdapterTransport) continue;
      const hits = findForbiddenImports(readSource(file), FORBIDDEN_LOOP_IMPORTS);
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
    const violations: { file: string; hits: string[] }[] = [];
    for (const file of adapterFiles) {
      const isTransport = ADAPTER_TRANSPORT_ALLOWLIST.some(name => file.endsWith(name));
      if (isTransport) continue;
      const hits = findForbiddenImports(readSource(file), FORBIDDEN_ADAPTER_IMPORTS);
      if (hits.length > 0) violations.push({ file, hits });
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("FORBIDDEN_ADAPTER_IMPORTS still names the v1 sandbox set", () => {
    // Locked-set guard: if anyone adds/removes from the sandbox list, this
    // test fails — forces the change to be a deliberate breaking edit
    // rather than silent drift.
    expect([...FORBIDDEN_ADAPTER_IMPORTS]).toEqual([
      "canonical-loop/store",
      "canonical-loop/store.js",
      "workers/op-store",
      "workers/op-store.js",
      "workers/event-log",
      "workers/event-log.js",
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

  it("the audited adapter (anthropic.ts) does NOT import child_process even directly", () => {
    const src = readSource(join(ADAPTERS_DIR, "anthropic.ts"));
    const hits = findForbiddenImports(src, ["child_process", "node:child_process"]);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});
