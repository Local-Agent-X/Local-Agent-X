// Logging proxy: LAX -> this -> Ollama. Records every request LAX makes (shape, sizes, options) to wire.jsonl.
// usage: node wire-proxy.mjs [listenPort=11435] [upstream=http://localhost:11434]
import { createServer, request as httpRequest } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? 11435);
const UP = new URL(process.argv[3] ?? "http://localhost:11434");
const LOG = new URL("./wire.jsonl", import.meta.url);

function summarize(path, body) {
  let j = null;
  try { j = JSON.parse(body); } catch { return { path, unparsed_bytes: body.length }; }
  const msgs = Array.isArray(j.messages) ? j.messages : [];
  const roles = msgs.map((m) => m.role);
  const sys = msgs.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  const first = msgs[0];
  return {
    path, model: j.model, stream: j.stream, think: j.think, format: j.format ? (typeof j.format === "string" ? j.format : "schema") : undefined,
    keep_alive: j.keep_alive, options: j.options, // native
    max_tokens: j.max_tokens, temperature: j.temperature, top_p: j.top_p, stop: j.stop, reasoning_effort: j.reasoning_effort, tool_choice: j.tool_choice, // /v1
    tools: Array.isArray(j.tools) ? j.tools.length : 0, tools_json_chars: Array.isArray(j.tools) ? JSON.stringify(j.tools).length : 0,
    tool_names: Array.isArray(j.tools) ? j.tools.map((t) => t.function?.name ?? t.name).slice(0, 60) : undefined,
    messages: msgs.length, roles: roles.slice(0, 40), system_count: sys.length, system_chars: sys.reduce((n, s) => n + s.length, 0),
    system_head: sys[0]?.slice(0, 400), system_tail: sys[0]?.slice(-300), first_role: first?.role,
    total_chars: body.length, other_keys: Object.keys(j).filter((k) => !["model", "messages", "stream", "think", "format", "keep_alive", "options", "tools", "max_tokens", "temperature", "top_p", "stop", "tool_choice", "reasoning_effort"].includes(k)),
  };
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const t0 = Date.now();
    if (req.method === "POST" && /\/(api\/chat|api\/generate|v1\/chat\/completions|api\/embed|api\/embeddings|v1\/embeddings)/.test(req.url)) {
      const s = summarize(req.url, body.toString("utf8"));
      appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...s }) + "\n");
    } else {
      appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), path: req.url, method: req.method, bytes: body.length }) + "\n");
    }
    const up = httpRequest({ host: UP.hostname, port: UP.port, method: req.method, path: req.url, headers: { ...req.headers, host: UP.host } }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      let bytes = 0;
      upRes.on("data", (c) => { bytes += c.length; res.write(c); });
      upRes.on("end", () => { res.end(); appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), response_for: req.url, status: upRes.statusCode, ms: Date.now() - t0, bytes }) + "\n"); });
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    up.end(body);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`wire-proxy listening on 127.0.0.1:${PORT} -> ${UP.href}, log: ${LOG.pathname}`));
