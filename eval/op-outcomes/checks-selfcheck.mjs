#!/usr/bin/env node
// Checker self-check for the site-matching cases — proves the grader before a
// model is graded by it. No model, no LAX server; only the fixture server and
// scratch copies of the clone fixtures.
//
// A site check must grade whether the clone MATCHES, not where the fix was
// typed. So for each case:
//   - the untouched clone                      → must FAIL
//   - the original page dropped in as the clone → must PASS (it IS the target)
//   - the rules inlined, stale styles.css kept  → must PASS (muse, 2026-09-16)
//   - the rules inlined, styles.css deleted     → must PASS
//   - styles.css fixed, page untouched          → must PASS
//
//   node eval/op-outcomes/checks-selfcheck.mjs
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeChecks, runCheck } from "./checks.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
const list = Array.isArray(cases) ? cases : cases.cases;

// case id → [clone dir, the original page it must match]
const SITES = {
  "match-original-site": ["bellavista-clone", "/site/original"],
  "multi-page-site-match": ["vistawell-clone", "/site2/"],
};

const fixture = await startFixtureServer();
let bad = 0;
try {
  for (const [id, [clone, originalPath]] of Object.entries(SITES)) {
    const checks = list.find((c) => c.id === id).checks.filter((c) => c.type === "renderedCss");
    const original = await (await fetch(fixture.baseUrl + originalPath)).text();
    const originalStyle = original.match(/<style\b[^>]*>[\s\S]*?<\/style>/i)?.[0] ?? "";

    const grade = async (mutate) => {
      const ws = mkdtempSync(join(tmpdir(), "lax-checks-selfcheck-"));
      try {
        cpSync(join(HERE, "fixtures", "workspace", clone), join(ws, clone), { recursive: true });
        mutate(join(ws, clone));
        const ctx = { workspace: ws, replies: [], toolsUsed: [], before: { hashes: {} }, fill: (s) => s };
        const out = [];
        for (const c of checks) out.push(await runCheck(c, ctx));
        return out;
      } finally { rmSync(ws, { recursive: true, force: true }); }
    };
    const inlineInto = (dir) => {
      const p = join(dir, "index.html");
      writeFileSync(p, readFileSync(p, "utf8").replace("</head>", `${originalStyle}</head>`));
    };
    // The file-based fix: append every expected declaration to styles.css.
    const fixSheet = (dir) => {
      const rules = checks.map((c) => `${c.selector}{${c.property}:${c.equals}}`).join("\n");
      writeFileSync(join(dir, "styles.css"), `${readFileSync(join(dir, "styles.css"), "utf8")}\n${rules}\n`);
    };

    const scenarios = [
      ["untouched clone", false, () => {}],
      ["original page as the clone", true, (d) => writeFileSync(join(d, "index.html"), original)],
      ["fixed via styles.css", true, fixSheet],
      // The Vistawell original is a <style> block; Bellavista's is inline
      // style="" attributes, which the original-page scenario already covers.
      ...(originalStyle ? [
        ["inlined, stale styles.css kept", true, inlineInto],
        ["inlined, styles.css deleted", true, (d) => { inlineInto(d); rmSync(join(d, "styles.css")); }],
      ] : []),
    ];
    for (const [name, shouldPass, mutate] of scenarios) {
      const results = await grade(mutate);
      const passed = results.every((r) => r.ok);
      const right = passed === shouldPass;
      if (!right) bad++;
      console.log(`${right ? "ok  " : "BAD "} ${id.padEnd(22)} ${name.padEnd(32)} ${passed ? "PASS" : "FAIL"} (expected ${shouldPass ? "PASS" : "FAIL"})`);
      if (!right) for (const r of results) console.log(`       ${r.ok ? "✓" : "✗"} ${r.detail}`);
    }
  }
} finally {
  await fixture.close();
  await closeChecks();
}
console.log(bad ? `\n${bad} scenario(s) graded wrongly — fix the checker before grading a model.` : "\nsite checks grade the outcome, not the file.");
process.exit(bad ? 1 : 0);
