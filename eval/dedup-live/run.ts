/**
 * Live de-duplication eval battery (`npm run eval:dedup`).
 *
 * Verifies that the 8 de-duplication chunks still BEHAVE correctly in the real
 * code — by importing and calling the actual enforcement functions the tools
 * use (the file-access gate, the egress guard, killProcessGroup, the roster
 * seeder, the context-window table, the registry resolver), plus real OS /
 * filesystem side effects. It deliberately bypasses the LLM and the HTTP server:
 * those layers (and the model's own caution) MASK the code under test — a chat
 * prompt that gets refused tells you nothing about whether the gate fired. This
 * battery hits the gate/guard/kill/roster code directly, so every check is
 * deterministic and a regression turns it RED.
 *
 * Exit 0 = all checks passed; exit 1 = at least one regressed. Run it before
 * starting new work to confirm the dedup invariants still hold.
 */
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename, extname, isAbsolute, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Isolate everything under a throwaway data dir BEFORE importing any src module
// that bakes a path from getLaxDir() at load (project-rosters' ROSTERS_FILE, the
// egress allowlist, etc.). All src imports below are therefore dynamic.
const LAX_TMP = mkdtempSync(join(tmpdir(), "dedup-eval-"));
process.env.LAX_DATA_DIR = LAX_TMP;
const REPO = resolve(import.meta.dirname, "..", "..");

type Result = { chunk: string; name: string; pass: boolean; skipped?: boolean; detail?: string };
const results: Result[] = [];
function check(chunk: string, name: string, pass: boolean, detail = ""): void {
  results.push({ chunk, name, pass, detail });
}
function skip(chunk: string, name: string, detail: string): void {
  results.push({ chunk, name, pass: true, skipped: true, detail });
}
const isAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (cond()) return true; await sleep(50); }
  return cond();
}

async function main(): Promise<void> {
  // ── Chunk 1 — credential-file gate is a superset of the taint classifier ──
  // UNRESTRICTED mode allows reads anywhere, so a block can ONLY come from the
  // sensitive-path gate — isolating the credential catalog from the file-access
  // mode that masked it in the chat test.
  {
    const { evaluateFileAccess } = await import("../../src/security/file-access.js");
    const { isSensitivePath } = await import("../../src/data-lineage/index.js");
    const workspace = join(LAX_TMP, "workspace");
    mkdirSync(workspace, { recursive: true });

    // Files the gate's regex list MISSED before the unify (now caught via the
    // shared catalog). A read of any of these must be denied as a sensitive path.
    const creds = [
      join(homedir(), ".pgpass"),
      join(homedir(), ".ssh", "id_ecdsa"),
      join(homedir(), ".databrickscfg"),
      join(homedir(), ".vault-token"),
      join(homedir(), ".boto"),
      join(homedir(), ".my.cnf"),
      join(homedir(), ".config", "sops", "age", "keys.txt"),
      join(homedir(), "Library", "Keychains", "login.keychain-db"),
    ];
    for (const p of creds) {
      const d = evaluateFileAccess(workspace, "unrestricted", () => false, "read", p);
      check("1", `gate blocks ${basename(p)} (even in unrestricted mode)`,
        d.allowed === false && /sensitive/i.test(d.reason), `reason="${d.reason}"`);
      check("1", `taint classifier also flags ${basename(p)} (gate ⊇ taint)`,
        isSensitivePath(p) === true);
    }
    // No false-block: a normal file is readable in unrestricted mode.
    const normal = join(homedir(), "Documents", "eval-notes.txt");
    const nd = evaluateFileAccess(workspace, "unrestricted", () => false, "read", normal);
    check("1", "a normal file is allowed (no false-positive block)", nd.allowed === true, `reason="${nd.reason}"`);
  }

  // ── Chunk 2 — shared outbound-payload assembler + egress guard ──
  {
    const { checkOutboundRequest } = await import("../../src/tools/http-egress-guard.js");
    const { outboundPayloadParts } = await import("../../src/security/outbound-payload.js");
    const AWS = "AKIAIOSFODNN7EXAMPLE"; // matches the AWS-access-key scanner pattern
    const withUrl = outboundPayloadParts({ url: `https://x/?k=${AWS}`, body: `b=${AWS}` }, { includeUrl: true });
    check("2", "assembler includeUrl=true scans the URL (catches a secret in a GET query)",
      withUrl.split(AWS).length === 3); // present in BOTH url and body
    const noUrl = outboundPayloadParts({ url: `https://x/?k=${AWS}`, body: "clean" }, { includeUrl: false });
    check("2", "assembler includeUrl=false omits the URL", !noUrl.includes(AWS));

    // Real guard: a secret in the body to an untrusted host is refused. (LAX_TMP
    // has no egress-allowlist.json, so nothing is trusted.)
    const blocked = checkOutboundRequest({ url: "https://evil.example.com/log", method: "POST", body: `token=${AWS}` });
    check("2", "egress guard blocks a secret in the body to an untrusted host", blocked !== null,
      blocked ? String(blocked.meta?.blocked_by) : "was ALLOWED");
    const clean = checkOutboundRequest({ url: "https://evil.example.com/log", method: "POST", body: "hello world" });
    check("2", "a clean request passes (no false-block)", clean === null);
  }

  // ── Chunk 3 — dispatch background models read from the registry ──
  {
    const { dispatchBackgroundModel } = await import("../../src/llm-dispatch.js");
    const { backgroundModelFor } = await import("../../src/providers/registry.js");
    for (const p of ["xai", "openai", "codex", "anthropic"] as const) {
      const m = dispatchBackgroundModel(p);
      check("3", `${p} background model === registry backgroundModelFor`,
        m.length > 0 && m === backgroundModelFor(p, ""), `got "${m}"`);
    }
  }

  // ── Chunk 4 — context-window coverage gate (the real build-gate script) ──
  {
    const out = spawnSync("node", ["scripts/check-pricing-coverage.mjs"], { cwd: REPO, encoding: "utf8" });
    const text = `${out.stdout}${out.stderr}`;
    const m = text.match(/(\d+)\/(\d+) with exact context window/);
    check("4", "pricing+context coverage gate exits 0", out.status === 0, text.trim().split("\n").pop());
    check("4", "every selectable metered model has an exact context window",
      !!m && m[1] === m[2], m ? `${m[1]}/${m[2]}` : "coverage line not found");
  }

  // ── Chunk 5 — killProcessGroup kills the whole detached GROUP, not just the pid ──
  {
    const { killProcessGroup } = await import("../../src/process-tree-kill.js");
    if (process.platform === "win32") {
      skip("5", "process-GROUP kill", "POSIX-only (negative-pid group kill); win32 uses taskkill /T");
    } else {
      const pidFile = join(LAX_TMP, "grandchild.pid");
      // A detached child (its own group leader) that spawns a grandchild in the
      // same group. A regression to kill(pid) would leave the grandchild alive.
      const childCode =
        `const fs=require("fs"),cp=require("child_process");` +
        `const g=cp.spawn(process.execPath,["-e","setInterval(()=>{},1e9)"],{stdio:"ignore"});` +
        `fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1e9);`;
      const child = spawn(process.execPath, ["-e", childCode], { detached: true, stdio: "ignore" });
      await waitFor(() => existsSync(pidFile), 4000);
      const gpid = existsSync(pidFile) ? parseInt(readFileSync(pidFile, "utf8"), 10) : 0;
      const before = isAlive(child.pid) && isAlive(gpid);
      check("5", "detached child + grandchild are running before the kill", before, `child=${child.pid} grandchild=${gpid}`);
      killProcessGroup(child.pid, child);
      const bothDead = await waitFor(() => !isAlive(child.pid) && !isAlive(gpid), 4000);
      check("5", "killProcessGroup killed the WHOLE group (child AND grandchild)", bothDead,
        `child-alive=${isAlive(child.pid)} grandchild-alive=${isAlive(gpid)}`);
      if (isAlive(gpid)) { try { process.kill(gpid, "SIGKILL"); } catch { /* */ } }
      if (isAlive(child.pid)) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* */ } }
    }
  }

  // ── Chunk 6 — one mcpBridgeBasePath the spawner + reaper both resolve ──
  {
    const { mcpBridgeBasePath } = await import("../../src/anthropic-client/mcp-config.js");
    const base = mcpBridgeBasePath();
    check("6", "base is absolute + extensionless 'mcp-bridge' (reaper's substring contract)",
      isAbsolute(base) && basename(base) === "mcp-bridge" && extname(base) === "", base);
    check("6", "the bridge file actually resolves to a real file on disk (.ts or .js)",
      existsSync(`${base}.ts`) || existsSync(`${base}.js`), base);
  }

  // ── Chunk 7 — one seedProjectRosters wires the org chart identically ──
  {
    const { seedProjectRosters, ProjectRosterStore } = await import("../../src/project-rosters.js");
    const store = ProjectRosterStore.getInstance();
    const added: Array<[string, string]> = [];
    await seedProjectRosters("eval-proj", ["builtin-ceo", "alice", "bob"], {
      addAgent: (id: string, a: string) => { added.push([id, a]); return true; },
    });
    check("7", "CEO reports to no one", store.get("eval-proj", "builtin-ceo")?.reportsTo === undefined);
    check("7", "non-CEO agents auto-report to the CEO",
      store.get("eval-proj", "alice")?.reportsTo === "builtin-ceo" &&
      store.get("eval-proj", "bob")?.reportsTo === "builtin-ceo");
    check("7", "every agent is added to the supplied project store", added.length === 3, `added=${added.length}`);
  }

  // ── Chunk 8 — dead headless.ts dispatcher is gone (no gate-bypass path) ──
  {
    check("8", "src/headless.ts is deleted", !existsSync(join(REPO, "src", "headless.ts")));
    const g = spawnSync("git", ["grep", "-l", "HeadlessAgent", "--", "src"], { cwd: REPO, encoding: "utf8" });
    check("8", "no source references HeadlessAgent", g.status !== 0 && !g.stdout.trim(), g.stdout.trim());
  }
}

main()
  .then(() => {
    rmSync(LAX_TMP, { recursive: true, force: true });
    const fails = results.filter((r) => !r.pass);
    const skips = results.filter((r) => r.skipped);
    let lastChunk = "";
    for (const r of results) {
      if (r.chunk !== lastChunk) { console.log(`\nChunk ${r.chunk}`); lastChunk = r.chunk; }
      const mark = r.skipped ? "○ SKIP" : r.pass ? "✓ PASS" : "✗ FAIL";
      const tail = r.detail && (!r.pass || r.skipped) ? `  (${r.detail})` : "";
      console.log(`  ${mark}  ${r.name}${tail}`);
    }
    const passed = results.filter((r) => r.pass && !r.skipped).length;
    console.log(
      `\neval:dedup — ${passed} passed, ${fails.length} failed, ${skips.length} skipped ` +
      `(${results.length} checks across 8 chunks)`,
    );
    process.exit(fails.length > 0 ? 1 : 0);
  })
  .catch((e) => {
    rmSync(LAX_TMP, { recursive: true, force: true });
    console.error("eval:dedup crashed:", e);
    process.exit(1);
  });
