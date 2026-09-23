// V4: the no-fold shape. r0u = r0 with its last user row split into
// [user text][volatile row]; r1u = r0u's rows + r1's rows beyond r0's length.
// If r1u reuses ~everything, "volatile text is always its own row" is the fix.
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const [root, opIdxS, r0S, r1S] = process.argv.slice(2);
const ops = readdirSync(root)
  .map((id) => ({ id, op: JSON.parse(readFileSync(join(root, id, "operation.json"), "utf8")) }))
  .filter(({ op }) => op.type === "chat_turn")
  .sort((a, b) => String(a.op.createdAt).localeCompare(String(b.op.createdAt)));
const trace = (i) => JSON.parse(gunzipSync(readFileSync(join(root, ops[Number(opIdxS)].id, "op-turns", `${i}.trace.json.gz`))).toString());
const t0 = trace(r0S), t1 = trace(r1S);

const last = t0.request.messages.at(-1);
const cut = String(last.content).search(/\n\n\[(SITUATIONAL|RECALLED) CONTEXT/);
if (last.role !== "user" || cut < 0) throw new Error("r0's last row is not a folded user row");
const r0u = [...t0.request.messages.slice(0, -1), { role: "user", content: String(last.content).slice(0, cut) }, { role: "user", content: String(last.content).slice(cut + 2) }];
const r1u = [...r0u, ...t1.request.messages.slice(t0.request.messages.length)];
const tools = t0.request.tools.map((x) => ({ type: "function", function: { name: x.name, description: x.description ?? "", parameters: x.parameters ?? {} } }));

for (const [label, messages] of [["r0 unfolded", r0u], ["r1 = r0 unfolded + new rows", r1u]]) {
  const body = { model: t0.model, messages: [{ role: "system", content: t0.request.systemPrompt }, ...messages], tools, temperature: 0, max_tokens: 1, stream: false };
  const started = Date.now();
  const j = await (await fetch("http://127.0.0.1:11434/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const u = j.usage ?? {};
  console.log(`${label}: prompt ${u.prompt_tokens} cached ${u.prompt_tokens_details?.cached_tokens ?? "?"} roles ${messages.map((m) => m.role[0]).join("")} ${Date.now() - started}ms${j.error ? " ERROR " + JSON.stringify(j.error).slice(0, 160) : ""}`);
}
