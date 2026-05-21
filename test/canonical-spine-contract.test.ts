/**
 * Architectural-contract regression tests for the "one spine" consolidation.
 *
 * These are STATIC checks — they read src/**\/*.ts as text and look for
 * import shapes, not runtime behavior. Static is the point: we want to
 * fail at `vitest run` time, before the violating code ever boots, so
 * an out-of-perimeter caller of the canonical-loop primitives can't
 * sneak in via a refactor or a "quick patch."
 *
 * Two contracts pinned here:
 *
 *   1. Canonical-loop entry-point functions (runAgentViaCanonical,
 *      runChatViaCanonical) may only be imported from a small set of
 *      spine-perimeter files. Everyone else uses invokeAgent /
 *      invokeDefinition (which dispatches through the registered
 *      AgentRunDriver).
 *
 *   2. The tool-execution primitives (executeToolCalls,
 *      dispatchSingleToolCall) may only be deep-imported from inside
 *      src/tool-execution/ or the canonical-loop bridge. Outside callers
 *      go through the re-export shim src/tool-executor.ts so any future
 *      pipeline restructure inside src/tool-execution/ doesn't fan out
 *      across consumers.
 *
 * If a violation appears, the failure message names the file, symbol,
 * and import path, plus the path you'd take to add a legitimate new
 * entry point (extend the allowlist below).
 *
 * The second test asserts exactly one production call to
 * registerAgentRunDriver. Two drivers means the second registration
 * wins and the first goes dead — the runtime.ts warning ("replacing
 * existing agent-run driver") is currently info-level; this test makes
 * the violation fail closed instead of a log line nobody reads.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SRC_ROOT = join(REPO_ROOT, "src");

// ── Helpers ────────────────────────────────────────────────────────────

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      // node_modules/dist are never in src/, but be defensive in case
      // someone vendors something there.
      if (name === "node_modules" || name === "dist") continue;
      out.push(...walkTsFiles(full));
    } else if (st.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so symbol/import scans don't false-positive on JSDoc
 *  prose like "* `runAgentViaCanonical` is the …". Strings are left in
 *  place — import statements never appear inside strings in practice,
 *  and stripping them risks munging template literals. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

interface ImportSite {
  symbols: string[];
  path: string;
  /** 1-indexed line number where the import statement starts. */
  line: number;
}

/** Extract both static and dynamic-await imports from a TS source.
 *  Default imports and namespace imports (`import x`, `import * as x`)
 *  are intentionally not parsed — none of the symbols we gate are
 *  exported as defaults, so the named-import shape covers every real
 *  consumer pattern. */
function parseImports(source: string): ImportSite[] {
  const cleaned = stripComments(source);
  const sites: ImportSite[] = [];

  const pushSymbols = (group: string, path: string, lineIndex: number): void => {
    const symbols = group
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    if (symbols.length > 0) sites.push({ symbols, path, line: lineIndex });
  };

  // line index lookup — map char offset → line number once per file.
  const lineOf = (offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < cleaned.length; i++) {
      if (cleaned.charCodeAt(i) === 10) line++;
    }
    return line;
  };

  const staticRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(cleaned))) {
    pushSymbols(m[1], m[2], lineOf(m.index));
  }

  const dynamicRe =
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynamicRe.exec(cleaned))) {
    pushSymbols(m[1], m[2], lineOf(m.index));
  }

  return sites;
}

function relSlash(absPath: string): string {
  return relative(REPO_ROOT, absPath).replace(/\\/g, "/");
}

function isInAllowlist(relPath: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) =>
    entry.endsWith("/") ? relPath.startsWith(entry) : relPath === entry,
  );
}

// ── Test 1: spine perimeter ───────────────────────────────────────────

interface SpineRule {
  symbols: readonly string[];
  /** Forbidden when an import's source path matches this. The match is
   *  against the literal import path string as written (e.g.
   *  "../canonical-loop/agent-runner.js"). */
  importPathPattern: RegExp;
  /** What to do instead — surfaced in the failure message so the next
   *  engineer doesn't have to re-derive the rationale. */
  useInstead: string;
  /** Files / directories permitted to use this import pattern. Suffix
   *  with "/" for a directory prefix; bare paths match the exact file.
   *  Paths are repo-relative, forward-slash separated. */
  allowlist: readonly string[];
}

const SPINE_RULES: readonly SpineRule[] = [
  {
    // The canonical-loop run-* functions are the spine itself. The
    // legitimate consumers are: (a) the canonical-loop directory that
    // hosts and re-exports them, and (b) the small set of entry-point
    // files that drive a canonical op directly — chat routes, scheduled
    // jobs, bridges, autopilot rounds, delegation, the AgentRunDriver
    // implementation. Anything else must spawn through invokeAgent so
    // the FieldAgent + AgentRunStore lifecycle is consistent.
    symbols: ["runAgentViaCanonical", "runChatViaCanonical"],
    importPathPattern: /canonical-loop\//,
    useInstead:
      "invokeAgent / invokeDefinition (src/agents/invoke.ts) — they dispatch through the registered AgentRunDriver, which is the single canonical entry from outside the spine perimeter.",
    allowlist: [
      "src/canonical-loop/",
      "src/agents/runtime.ts",
      "src/agents/invoke.ts",
      "src/server/handler-events.ts",
      "src/server/lifecycle.ts",
      "src/server/background-jobs.ts",
      "src/server/bootstrap-bridges.ts",
      "src/autopilot/round-agent.ts",
      "src/routes/chat/run-chat-turn.ts",
      "src/routes/chat/delegation-handoff.ts",
    ],
  },
  {
    // Tool-execution dispatch primitives. Consumers should import from
    // the public shim src/tool-executor.ts so any reshuffle inside
    // src/tool-execution/ stays internal — this is exactly the role of
    // the shim, and it only buys us anything if nobody bypasses it.
    symbols: ["executeToolCalls", "dispatchSingleToolCall"],
    importPathPattern: /tool-execution\//,
    useInstead:
      "the re-export shim src/tool-executor.ts (`import { executeToolCalls } from \"./tool-executor.js\"`) so internal pipeline restructure doesn't fan out.",
    allowlist: [
      "src/tool-execution/",
      "src/canonical-loop/",
    ],
  },
];

describe("canonical-spine contract — import-boundary lint", () => {
  for (const rule of SPINE_RULES) {
    it(`only allowlisted files may deep-import [${rule.symbols.join(", ")}] from ${rule.importPathPattern}`, () => {
      const violations: string[] = [];

      for (const abs of walkTsFiles(SRC_ROOT)) {
        const rel = relSlash(abs);
        if (isInAllowlist(rel, rule.allowlist)) continue;

        const source = readFileSync(abs, "utf-8");
        for (const site of parseImports(source)) {
          if (!rule.importPathPattern.test(site.path)) continue;
          const hits = site.symbols.filter((s) => rule.symbols.includes(s));
          if (hits.length === 0) continue;
          violations.push(
            `  ${rel}:${site.line} imports { ${hits.join(", ")} } from "${site.path}"`,
          );
        }
      }

      if (violations.length > 0) {
        const msg = [
          `Spine-perimeter violation: ${violations.length} file(s) deep-import [${rule.symbols.join(", ")}] from outside the allowlist.`,
          "",
          ...violations,
          "",
          `Use instead: ${rule.useInstead}`,
          "",
          "If the violating file is a legitimate new spine entry point, add it to the rule's `allowlist` in test/canonical-spine-contract.test.ts.",
        ].join("\n");
        expect.fail(msg);
      }
    });
  }
});

// ── Test 2: single AgentRunDriver registration ────────────────────────

describe("canonical-spine contract — exactly one AgentRunDriver", () => {
  it("exactly one production file calls registerAgentRunDriver()", () => {
    // src/agents/runtime.ts both declares the function and (in JSDoc)
    // mentions it; tests register stub drivers but those live under
    // test/, which we don't scan here. Anywhere else with a real call
    // means a second driver registration competing with the canonical
    // one — last writer wins and the loser silently goes dead.
    const DEFINER = "src/agents/runtime.ts";
    const EXPECTED_CALLER = "src/server/handler-events.ts";
    const CALL_RE = /(?:^|[^a-zA-Z0-9_$])registerAgentRunDriver\s*\(/;

    const callers: string[] = [];
    for (const abs of walkTsFiles(SRC_ROOT)) {
      const rel = relSlash(abs);
      if (rel === DEFINER) continue;
      const cleaned = stripComments(readFileSync(abs, "utf-8"));
      if (CALL_RE.test(cleaned)) callers.push(rel);
    }

    if (callers.length === 1 && callers[0] === EXPECTED_CALLER) return;

    const msg = [
      `AgentRunDriver registration contract violated.`,
      `  Expected: exactly one call to registerAgentRunDriver() in ${EXPECTED_CALLER}`,
      `  Found:    ${callers.length} call site(s): [${callers.join(", ") || "(none)"}]`,
      "",
      callers.length === 0
        ? "No driver is registered — invokeAgent will throw 'no agent-run driver registered' at first dispatch."
        : "Multiple registrations replace each other (see runtime.ts: 'replacing existing agent-run driver'). The losing driver goes silently dead.",
      "",
      "If a legitimate second driver is being introduced (e.g. test harness on a non-test file path), revisit registerAgentRunDriver in src/agents/runtime.ts to support driver composition first — or move the registration into the canonical handler-events.ts.",
    ].join("\n");
    expect.fail(msg);
  });
});
