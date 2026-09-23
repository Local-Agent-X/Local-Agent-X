// Per-round wire diff for one kept op store: for each chat op, in order, print
// each round's prompt/cached tokens and where round r's rendered request first
// differs from round r-1's (system prompt, tools, then messages as JSON).
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const root = process.argv[2];
const ops = readdirSync(root)
  .map((id) => ({ id, op: JSON.parse(readFileSync(join(root, id, "operation.json"), "utf8")) }))
  .filter(({ op }) => op.type === "chat_turn")
  .sort((a, b) => String(a.op.createdAt).localeCompare(String(b.op.createdAt)));

const trace = (id, i) => JSON.parse(gunzipSync(readFileSync(join(root, id, "op-turns", `${i}.trace.json.gz`))).toString());
const turn = (id, i) => JSON.parse(readFileSync(join(root, id, "op-turns", `${i}.json`), "utf8")).turn?.providerState?.providerPayload ?? {};
const commonPrefix = (a, b) => { let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++; return k; };

let prev = null;
ops.forEach(({ id }, opIdx) => {
  const rounds = readdirSync(join(root, id, "op-turns")).filter((f) => /^\d+\.trace\.json\.gz$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b);
  for (const r of rounds) {
    const t = trace(id, r); const p = turn(id, r);
    const req = t.request;
    const sys = req.systemPrompt ?? ""; const tools = JSON.stringify(req.tools); const msgs = JSON.stringify(req.messages);
    const input = p.usageInputTokens ?? p.usagePromptTokens ?? 0; const cached = p.cacheReadTokens ?? p.promptCachedTokens ?? 0;
    let where = "first";
    if (prev) {
      if (sys !== prev.sys) where = `SYSTEM differs at ${commonPrefix(sys, prev.sys)}/${prev.sys.length}: ${JSON.stringify(sys.slice(Math.max(0, commonPrefix(sys, prev.sys) - 40), commonPrefix(sys, prev.sys) + 80))}`;
      else if (tools !== prev.tools) where = `TOOLS differ (${prev.tools.length}->${tools.length})`;
      else {
        const k = commonPrefix(msgs, prev.msgs);
        where = `messages common ${k}/${prev.msgs.length} (${(100 * k / prev.msgs.length).toFixed(1)}%): ${JSON.stringify(prev.msgs.slice(Math.max(0, k - 60), k + 100))}`;
      }
    }
    const roles = req.messages.map((m) => m.role[0]).join("");
    console.log(`op${opIdx} r${r}: in ${input} cached ${cached} uncached ${input - cached} | roles ${roles} | ${where}`);
    prev = { sys, tools, msgs };
  }
});
