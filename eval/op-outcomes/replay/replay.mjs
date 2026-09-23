// Replay traced requests against the local runtime and read what it cached.
//   node replay.mjs <opsDir> <opIdx> <round> [<opIdx> <round> ...] [--strip-last-user] [--no-tools]
// Each request is sent as the trace recorded it (system + messages + tools),
// stream=false, max_tokens=1; prints prompt tokens and cached tokens.
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const args = process.argv.slice(2);
const root = args.shift();
const flags = new Set(args.filter((a) => a.startsWith("--")));
const pairs = args.filter((a) => !a.startsWith("--")).map(Number);
const ops = readdirSync(root)
  .map((id) => ({ id, op: JSON.parse(readFileSync(join(root, id, "operation.json"), "utf8")) }))
  .filter(({ op }) => op.type === "chat_turn")
  .sort((a, b) => String(a.op.createdAt).localeCompare(String(b.op.createdAt)));
const trace = (id, i) => JSON.parse(gunzipSync(readFileSync(join(root, id, "op-turns", `${i}.trace.json.gz`))).toString());

for (let i = 0; i < pairs.length; i += 2) {
  const t = trace(ops[pairs[i]].id, pairs[i + 1]);
  let messages = [{ role: "system", content: t.request.systemPrompt }, ...t.request.messages];
  let label = `op${pairs[i]} r${pairs[i + 1]}`;
  if (flags.has("--strip-last-user") && messages.at(-1).role === "user") { messages = messages.slice(0, -1); label += " (last user row stripped)"; }
  // Mutations of the LAST row, for bisecting what defeats reuse.
  if (flags.has("--drop-last")) { messages = messages.slice(0, -1); label += " (last row dropped)"; }
  if (flags.has("--last-digest-only")) { const l = messages.at(-1); const c = String(l.content); const i = c.indexOf("\n\n[RECALLED CONTEXT"); if (i >= 0) { messages = [...messages.slice(0, -1), { role: l.role, content: c.slice(0, i) }]; label += " (recall stripped from last row)"; } }
  if (flags.has("--last-recall-only")) { const l = messages.at(-1); const c = String(l.content); const i = c.indexOf("[RECALLED CONTEXT"); if (i >= 0) { messages = [...messages.slice(0, -1), { role: l.role, content: c.slice(i) }]; label += " (digest stripped from last row)"; } }
  if (flags.has("--drop-empty-assistant")) { messages = messages.filter((m) => !(m.role === "assistant" && (m.content === "" || m.content == null) && !m.tool_calls)); label += " (empty assistant rows dropped)"; }
  // --prefix-from=o,r : keep that round's rows verbatim as the head and append
  // only the rows this round has beyond them (a strict row-extension).
  const pf = [...flags].find((f) => f.startsWith("--prefix-from="));
  if (pf) {
    const [po, pr] = pf.slice("--prefix-from=".length).split(",").map(Number);
    const head = trace(ops[po].id, pr).request.messages;
    messages = [{ role: "system", content: t.request.systemPrompt }, ...head, ...t.request.messages.slice(head.length)];
    label += ` (rows 0-${head.length - 1} verbatim from op${po} r${pr})`;
  }
  const body = {
    model: t.model,
    messages,
    ...(flags.has("--no-tools") ? {} : { tools: t.request.tools.map((x) => ({ type: "function", function: { name: x.name, description: x.description ?? "", parameters: x.parameters ?? {} } })) }),
    temperature: 0,
    max_tokens: 1,
    stream: false,
  };
  const started = Date.now();
  const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  const u = j.usage ?? {};
  console.log(`${label}: status ${res.status} prompt ${u.prompt_tokens} cached ${u.prompt_tokens_details?.cached_tokens ?? "?"} roles ${messages.map((m) => m.role[0]).join("")} ${Date.now() - started}ms${j.error ? " ERROR " + JSON.stringify(j.error).slice(0, 200) : ""}`);
}
