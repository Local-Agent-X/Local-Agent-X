#!/usr/bin/env node
/**
 * eval-gate — pre-commit gate for prompt + tool-routing changes.
 *
 * Runs the tool-discovery eval and blocks the commit if score < threshold.
 *
 * Fires only when the staged diff touches files that demonstrably affect
 * tool discovery:
 *   - config/system-prompt.md    (the prompt rules the agent reads)
 *   - src/agent-request/tool-filter.ts  (which tools main-chat sees eagerly)
 *   - src/agent-request/audience-tagger.ts  (which audiences each tool belongs to)
 *   - eval/tool-discovery/cases.json  (the test set itself — protect against
 *     someone "fixing" a regression by deleting the case)
 *
 * Designed for the .git/hooks/pre-commit shim — exits non-zero on failure to
 * abort the commit. Skipped automatically when:
 *   - SKIP_EVAL_GATE=1 in the env (escape hatch for emergency commits)
 *   - The server isn't running (no point gating on an offline eval)
 *   - None of the trigger files are staged
 *
 * Why not full CI: we have no CI yet. The pre-commit hook gives us
 * something today; CI runs a longer/wider eval matrix when it lands.
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── Escape hatches ──
if (process.env.SKIP_EVAL_GATE === "1") {
  console.log("[eval-gate] Skipped via SKIP_EVAL_GATE=1");
  process.exit(0);
}

// ── Only fire on relevant staged files ──
const TRIGGER_FILES = [
  "config/system-prompt.md",
  "src/agent-request/tool-filter.ts",
  "src/agent-request/audience-tagger.ts",
  "eval/tool-discovery/cases.json",
];
let staged = "";
try {
  staged = execSync("git diff --cached --name-only", { cwd: REPO_ROOT, encoding: "utf-8" });
} catch {
  console.log("[eval-gate] git diff failed — skipping gate");
  process.exit(0);
}
const stagedFiles = staged.split("\n").map((s) => s.trim()).filter(Boolean);
const triggered = stagedFiles.filter((f) => TRIGGER_FILES.some((t) => f === t || f.endsWith(t)));
if (triggered.length === 0) {
  process.exit(0); // Nothing relevant staged — no need to gate
}
console.log(`[eval-gate] Triggered by: ${triggered.join(", ")}`);

// ── Server reachable? If not, defer to the developer ──
const CONFIG_PATH = join(homedir(), ".lax", "config.json");
if (!existsSync(CONFIG_PATH)) {
  console.log("[eval-gate] No ~/.lax/config.json — skipping gate");
  process.exit(0);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const baseUrl = `http://127.0.0.1:${cfg.port || 7007}`;
try {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: { Authorization: `Bearer ${cfg.authToken}` },
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  console.log(`[eval-gate] Server not reachable (${e.message}) — skipping gate.`);
  console.log(`[eval-gate] Start the server and re-commit to enforce the threshold.`);
  process.exit(0);
}

// ── Threshold ──
const thresholdPath = join(REPO_ROOT, "eval", "tool-discovery", "threshold.json");
if (!existsSync(thresholdPath)) {
  console.log("[eval-gate] threshold.json missing — skipping gate");
  process.exit(0);
}
const threshold = JSON.parse(readFileSync(thresholdPath, "utf-8"));
const minPass = Number(threshold.minPass) || 0;

// ── Run the eval ──
console.log(`[eval-gate] Running tool-discovery eval (threshold: ${minPass}/${threshold.totalCases})…`);
console.log(`[eval-gate] This takes ~5-10 min; don't use the app during the run.`);
const evalRun = spawnSync(process.execPath, [join(REPO_ROOT, "eval", "tool-discovery", "run.mjs")], {
  cwd: REPO_ROOT,
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
});
const out = (evalRun.stdout || "") + (evalRun.stderr || "");
console.log(out);

// Parse "Passed: N/M" line out of the eval's output
const passLine = out.match(/Passed:\s+(\d+)\/(\d+)/);
if (!passLine) {
  console.error("[eval-gate] Couldn't parse eval result — refusing to gate. Manual review needed.");
  process.exit(1);
}
const passed = Number(passLine[1]);
const total = Number(passLine[2]);

if (passed < minPass) {
  console.error(``);
  console.error(`[eval-gate] FAIL — ${passed}/${total} passed, threshold is ${minPass}.`);
  console.error(`[eval-gate] This commit would regress tool discovery. Options:`);
  console.error(`[eval-gate]   1. Adjust the prompt change so the eval recovers, then re-commit.`);
  console.error(`[eval-gate]   2. If the failing cases were obsolete, update eval/tool-discovery/cases.json AND lower the threshold consciously.`);
  console.error(`[eval-gate]   3. Bypass: SKIP_EVAL_GATE=1 git commit … (escape hatch — leaves a regression in)`);
  console.error(``);
  process.exit(1);
}

console.log(`[eval-gate] PASS — ${passed}/${total} (threshold ${minPass}).`);
process.exit(0);
