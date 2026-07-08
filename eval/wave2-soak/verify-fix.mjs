// Live re-verification of the classifier-reroute fix (de2214d6): boot the
// isolated soak server at HEAD, drive ONE curate session, and check that the
// end-of-turn extraction classifier actually runs (the exact thing that was
// silently dead in pass 1).
import { spawn } from "node:child_process";
import { readFileSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REPO_ROOT = "/Users/dad/Projects/Local-Agent-X";
const SOAK_DIR = join(homedir(), "lax-soak");
const PORT = 7017;
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `soakfix-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logMark = existsSync(join(SOAK_DIR, "logs", "server.log"))
  ? readFileSync(join(SOAK_DIR, "logs", "server.log"), "utf-8").length
  : 0;

try { await fetch(`${BASE}/api/health`); console.error("port busy"); process.exit(2); } catch { /* free */ }

const logFd = openSync(join(SOAK_DIR, "boot.log"), "a");
const child = spawn(process.execPath, ["--import=tsx", "src/index.ts"], {
  cwd: REPO_ROOT,
  env: { ...process.env, LAX_DATA_DIR: SOAK_DIR, LAX_PORT: String(PORT), LAX_WORKSPACE: join(SOAK_DIR, "workspace") },
  stdio: ["ignore", logFd, logFd],
});

let H = null;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  try {
    const cfg = JSON.parse(readFileSync(join(SOAK_DIR, "config.json"), "utf-8"));
    H = { Authorization: `Bearer ${cfg.authToken}`, "Content-Type": "application/json" };
    const r = await fetch(`${BASE}/api/health`, { headers: H });
    if (r.ok) break;
  } catch { /* not up yet */ }
  await sleep(1000);
}
console.log("[verify] server healthy");

async function turn(message, sessionId) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 180_000);
  let text = "", err = "";
  try {
    const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: H, body: JSON.stringify({ message, sessionId }), signal: ac.signal });
    let buf = "";
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      let i; while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === "stream" && typeof ev.delta === "string") text += ev.delta;
        if (ev.type === "error") err = ev.message;
      }
    }
  } catch (e) { err = e.message; }
  clearTimeout(t);
  return { text: text.slice(0, 120), err };
}

const sid = `${TAG}-curate`;
console.log("[verify] t1:", JSON.stringify(await turn("Remember that I prefer tabs over spaces in all my projects.", sid)));
console.log("[verify] t2:", JSON.stringify(await turn("Thanks. One-line answer: why do some people prefer spaces?", sid)));
console.log("[verify] draining 20s for end-of-turn extraction");
await sleep(20_000);

child.kill("SIGTERM");
await Promise.race([new Promise((r) => child.once("exit", r)), sleep(15_000)]);

const log = readFileSync(join(SOAK_DIR, "logs", "server.log"), "utf-8").slice(logMark);
const grab = (re) => (log.match(re) || []).slice(0, 6);
const userMd = existsSync(join(SOAK_DIR, "memory", "USER.md")) ? readFileSync(join(SOAK_DIR, "memory", "USER.md"), "utf-8") : "";
const report = {
  rerouteLines: grab(/.*reroute.*/gi),
  coalescerLines: grab(/.*coalesc.*/gi),
  eotLines: grab(/.*end-of-turn.*/gi),
  boostLines: grab(/.*curate-nudge.*boost.*/gi),
  codexCredErrors: (log.match(/no credential found for provider "codex"/g) || []).length,
  userMdMentionsTabs: /tab/i.test(userMd),
  userMdBytes: userMd.length,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(join(SOAK_DIR, `verify-${TAG}.json`), JSON.stringify(report, null, 2));
