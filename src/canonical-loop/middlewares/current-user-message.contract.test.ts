/**
 * Contract: no middleware reads `ctx.userMessage`.
 *
 * `userMessage` is the FIRST user row in op_messages (host.ts). Because
 * seed-messages writes the whole prior conversation as user rows and the
 * current message LAST, that field holds the session's OPENING line on every
 * op after the first — not the request this op is running on. Ten middlewares
 * read it and judged / classified / extracted against the wrong message
 * (verified on op_chat_turn_690ce6c3cd1b4394: op.task = "Hi", userMessage =
 * "Yo"). They were migrated to `ctx.currentUserMessage` (= op.task), and this
 * test keeps them off the stale field: a new middleware, or a revert, fails
 * here by file name.
 *
 * Two assertions:
 *   1. No non-test source in this directory reads `.userMessage` (comments
 *      stripped first — the types.ts docstring legitimately cites
 *      `args.userMessage` at a call site elsewhere).
 *   2. host.ts still POPULATES `userMessage`. The field stays for any external
 *      reader; this contract is about middleware reads, not the field's
 *      existence.
 *
 * ALLOWLIST is empty by default. A middleware that genuinely needs the
 * session-OPENING message rather than the op-opening one goes there with a
 * comment proving why; none is expected.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

/** Files permitted to read `.userMessage`. Add an entry ONLY with a comment
 *  proving the reader needs the session's first message, not the op's. */
const ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/** The populator — it assigns the field, it does not read it. */
const POPULATOR = "host.ts";

const isSource = (name: string) =>
  name.endsWith(".ts") &&
  !name.endsWith(".test.ts") &&
  !name.endsWith(".test-helper.ts") &&
  !name.endsWith(".d.ts");

/** Drop block and line comments so a docstring citing the field elsewhere
 *  (types.ts) does not count as a read. Line-preserving — a block comment is
 *  replaced by its own newlines — so the reported line number is the real one.
 *  Strings are not stripped: a middleware quoting "ctx.userMessage" in a nudge
 *  would be as wrong as reading it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const READ_RE = /\.userMessage\b/;

function offendingLines(src: string): number[] {
  const out: number[] = [];
  stripComments(src).split(/\r?\n/).forEach((line, i) => {
    if (READ_RE.test(line)) out.push(i + 1);
  });
  return out;
}

describe("current-user-message contract", () => {
  const sources = readdirSync(DIR).filter(isSource).sort();

  it("sees the middleware sources it is guarding", () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources).toContain(POPULATOR);
  });

  it("no middleware reads ctx.userMessage — the session's opening line, not this op's request", () => {
    const offenders: string[] = [];
    for (const name of sources) {
      if (name === POPULATOR || ALLOWLIST.has(name)) continue;
      const lines = offendingLines(readFileSync(join(DIR, name), "utf8"));
      if (lines.length) offenders.push(`${name}:${lines.join(",")}`);
    }
    expect(
      offenders,
      `These middlewares read \`.userMessage\` — the session's FIRST message, not the one that ` +
        `opened this op. Read \`ctx.currentUserMessage\` instead (see types.ts). Offending: ` +
        offenders.join("; "),
    ).toEqual([]);
  });

  it("host.ts still populates userMessage — the field stays for external readers", () => {
    const src = readFileSync(join(DIR, POPULATOR), "utf8");
    expect(src).toMatch(/^\s*let userMessage = "";\s*$/m);
    expect(src).toMatch(/^\s*userMessage,\s*$/m);
    expect(src).toMatch(/^\s*currentUserMessage,\s*$/m);
  });

  it("the allowlist is empty — every reader was migrated", () => {
    expect([...ALLOWLIST]).toEqual([]);
  });
});
