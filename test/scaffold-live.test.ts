/**
 * The real thing, on a schedule: every framework creator in SCAFFOLDS plus the
 * harness-owned Vite plan is run for real in a temp dir, the structure kit is
 * applied, and the project's own `node scripts/check-structure.mjs` and test
 * script run. Creators move (flags, templates, layouts); this is where a moved
 * one shows up before a user's build does.
 *
 * Gated by LAX_SCAFFOLD_LIVE=1 (`npm run test:scaffold-live` sets it through
 * vitest.scaffold-live.config.ts); the default suite skips it, because it
 * downloads packages and takes minutes. Not caged: a developer's test, not a
 * build op.
 *
 * What passes: the creator exits 0, the kit lands, and the structure check is
 * green or fails ONLY on module ownership — the one decision a creator cannot
 * make for the project (a Remix `app/routes/` needs its row); any other failing
 * check, or a crash, is a kit regression. A project with a test script (Vite,
 * through the plan's vitest) must pass it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyProjectKit, STRUCTURE_CHECK_SCRIPT } from "../src/app-scaffold/project-kit.js";
import { scaffoldCreators, viteScaffoldPlan } from "../src/tools/framework-scaffold.js";

const LIVE = process.env.LAX_SCAFFOLD_LIVE === "1";
const STEP_TIMEOUT_MS = 10 * 60_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function run(command: string, cwd: string): { status: number | null; out: string } {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf-8", timeout: STEP_TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1", CI: "1" } });
  return { status: r.status, out: `$ ${command}\n${r.stdout}${r.stderr}` };
}

/** The plan's commands and files for Vite (what the harness really runs); the
 *  creator then an install for every other framework. */
function scaffold(framework: string, creator: string, dir: string): string {
  const log: string[] = [];
  if (framework === "vite") {
    const plan = viteScaffoldPlan("live-app");
    for (const c of plan.commands) {
      const r = run(c, dir);
      log.push(r.out);
      expect(r.status, log.join("\n")).toBe(0);
    }
    for (const f of plan.files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    return log.join("\n");
  }
  for (const c of [creator, "npm install"]) {
    const r = run(c, dir);
    log.push(r.out);
    expect(r.status, log.join("\n")).toBe(0);
  }
  return log.join("\n");
}

const onlyOwnershipFailed = (out: string): boolean =>
  /check-structure: 1 of 4 checks failed/.test(out) && /check-module-owners: \d+ module\(s\) with no owner/.test(out);

describe.skipIf(!LIVE)("scaffold live: every creator, then the kit, then the project's own checks", () => {
  it.each(scaffoldCreators())("$label", ({ framework, creator }) => {
    // A real app dir is workspace/apps/<lowercase-name>; creators derive the
    // package name from the directory and reject npm-invalid names.
    const parent = mkdtempSync(join(tmpdir(), `lax-scaffold-live-${framework}-`));
    dirs.push(parent);
    const dir = join(parent, "live-app");
    mkdirSync(dir);
    const log = scaffold(framework, creator, dir);
    expect(existsSync(join(dir, "package.json")), log).toBe(true);

    // A creator may ship its own AGENTS.md (Astro's minimal template does);
    // the kit never overwrites a file that exists, so that one is skipped.
    const kit = applyProjectKit(dir, { projectName: "live-app" });
    expect(kit.written, log).toEqual(expect.arrayContaining(["ARCHITECTURE.md", "scripts/check-structure.mjs"]));
    expect(kit.wiredNpmScripts).toBe(true);

    const check = run(`node ${STRUCTURE_CHECK_SCRIPT}`, dir);
    expect(check.status === 0 || (check.status === 1 && onlyOwnershipFailed(check.out)), check.out).toBe(true);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) {
      const test = run("npm test", dir);
      expect(test.status, test.out).toBe(0);
    }
    console.log(`[scaffold-live] ${framework}: creator ok, kit ${kit.written.length} files written (${kit.skipped.join(", ") || "none"} already there), structure ${check.status === 0 ? "green" : "ownership rows pending"}, test script ${pkg.scripts?.test ? "passed" : "none"}`);
  });
});
