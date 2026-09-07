/**
 * Every op that reaches the worker must carry `contextPack.routing.authSource`.
 *
 * Why this is load-bearing: cost-recording.ts books an op's ledger row under
 * that field and checkpoint-stop.ts judges the spend ceiling by it, and
 * cost-tracker's `isBillableSource(undefined)` is TRUE by design. So an
 * op-creation site that builds its pack without the source makes every op it
 * creates count as real API spend — on a subscription (oauth) box, cron /
 * dream / voice / skill-review / autopilot / build_app usage was booked
 * toward the $75/day ceiling and could be checkpoint-stopped "for money".
 *
 * This is a STATIC test over the call sites, because the sites resolve their
 * credential through five different seams (register-adapter, the lane-default
 * adapter, resolveCredential, configureDelegatedRuntime, the verification
 * runtime) and a single runtime harness that exercises all of them does not
 * exist. Each site is pinned to one of two accepted shapes:
 *
 *   (a) the `buildContextPack({ … })` call passes `authSource:` — the site
 *       knows its credential before it builds the pack;
 *   (b) the same file stamps `.contextPack.routing.authSource = ` after the
 *       pack is built — the site resolves the credential later (the delegated
 *       op_submit* path and the verification runtime both do).
 *
 * A NEW call site fails this test until it does one of the two. The expected
 * list is pinned too, so a site that vanishes (or moves) is noticed rather
 * than silently dropping out of coverage.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_SITES = [
  "canonical-loop/agent-runner/run.ts",
  "canonical-loop/chat-runner/create-op.ts",
  "canonical-loop/verification-submit.ts",
  "ops/tools/shared.ts",
  "routes/chat/delegation-handoff.ts",
  "tools/build-app.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      walk(full, out);
    } else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** The argument text of every `buildContextPack({ … })` call in `source`. */
function contextPackCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "buildContextPack(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) return calls;
    let depth = 0;
    let end = at + marker.length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "(" || ch === "{") depth++;
      else if (ch === ")" || ch === "}") {
        if (depth === 0) break;
        depth--;
      }
    }
    calls.push(source.slice(at + marker.length, end));
    from = end;
  }
}

describe("every buildContextPack call site carries routing.authSource", () => {
  const sites = walk(SRC_ROOT)
    .filter((file) => !file.endsWith(`ops${sep}context-pack-builder.ts`))
    .map((file) => ({ file, rel: relative(SRC_ROOT, file).split(sep).join("/"), source: readFileSync(file, "utf8") }))
    .filter(({ source }) => source.includes("buildContextPack("));

  it("the set of call sites is the pinned one", () => {
    expect(sites.map((s) => s.rel).sort()).toEqual([...EXPECTED_SITES].sort());
  });

  it.each(sites.map((s) => [s.rel, s] as const))("%s passes or stamps authSource", (_rel, site) => {
    const calls = contextPackCalls(site.source);
    expect(calls.length).toBeGreaterThan(0);
    const passesAtCall = calls.every((args) => /\bauthSource\s*:/.test(args));
    const stampsAfter = /\.contextPack\.routing\.authSource\s*=/.test(site.source);
    expect(passesAtCall || stampsAfter).toBe(true);
  });
});
