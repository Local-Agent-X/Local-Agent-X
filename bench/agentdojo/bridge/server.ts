// Bench bridge HTTP server. One process exposes both:
//   - the OpenAI-compatible LLM shim (/v1/*) that drives AgentDojo's agent via claude
//   - the whole-stack guard (/guard/*) + run lifecycle (/run/*) + live scoreboard
//
// Run:  npx tsx bench/agentdojo/bridge/server.ts   (PORT env, default 8900)
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletion } from "./llm-shim.js";
import { setThreatDataDir, beginRun, endRun, guardToolCall, guardToolOutput, egressScan, type ConfigName } from "./guard.js";
import { recordEpisode, recordBlock, renderHtml, snapshot } from "./scoreboard.js";

const PORT = Number(process.env.PORT || 8900);
setThreatDataDir(mkdtempSync(join(tmpdir(), "ari-bench-threat-")));

// runId encodes `config|suite|userTask|injTask` so a denied call can be attributed
// to (config, suite) without global per-run state — safe under concurrent episodes.
function parseRunId(runId: string): { config: string; suite: string } {
  const [config = "off", suite = "?"] = (runId || "").split("|");
  return { config, suite };
}

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = req.url || "";
  const send = (code: number, obj: unknown, type = "application/json") => {
    const body = type === "application/json" ? JSON.stringify(obj) : String(obj);
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };
  try {
    if (req.method === "GET" && url === "/health") return send(200, { ok: true });
    if (req.method === "GET" && url.startsWith("/scoreboard.json")) return send(200, snapshot());
    if (req.method === "GET" && url.startsWith("/scoreboard")) return send(200, renderHtml(), "text/html");
    if (req.method === "GET" && url === "/v1/models")
      return send(200, { object: "list", data: [{ id: process.env.BENCH_MODEL || "sonnet", object: "model" }] });

    if (req.method === "POST" && url === "/v1/chat/completions") {
      const body = await readBody(req);
      const out = await handleChatCompletion(body as never);
      return send(200, out);
    }

    if (req.method === "POST" && url === "/run/begin") {
      const b = (await readBody(req)) as { runId: string; config: ConfigName; suite: string };
      beginRun(b.runId, b.config);
      return send(200, { ok: true });
    }
    if (req.method === "POST" && url === "/run/end") {
      const b = (await readBody(req)) as { runId: string };
      endRun(b.runId);
      return send(200, { ok: true });
    }

    if (req.method === "POST" && url === "/guard/tool-call") {
      const b = (await readBody(req)) as { runId: string; tool: string; args: Record<string, unknown> };
      const verdict = await guardToolCall(b.runId, b.tool, b.args || {});
      if (!verdict.allowed && verdict.stage) {
        const { config, suite } = parseRunId(b.runId);
        recordBlock(config, suite, verdict.stage);
      }
      return send(200, verdict);
    }
    if (req.method === "POST" && url === "/guard/egress-scan") {
      const b = (await readBody(req)) as { tool: string; args: Record<string, unknown> };
      return send(200, egressScan(b.tool, b.args || {}));
    }
    if (req.method === "POST" && url === "/guard/tool-output") {
      const b = (await readBody(req)) as { runId: string; tool: string; args: Record<string, unknown>; output: string };
      return send(200, guardToolOutput(b.runId, b.tool, b.args || {}, b.output ?? ""));
    }

    if (req.method === "POST" && url === "/score") {
      const b = (await readBody(req)) as {
        config: string; suite: string; utility_passed: boolean; security_passed: boolean | null;
      };
      recordEpisode(b);
      return send(200, { ok: true });
    }

    send(404, { error: "not found", url });
  } catch (e) {
    send(500, { error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bench-bridge] listening on http://127.0.0.1:${PORT}`);
  console.log(`[bench-bridge] live scoreboard → http://127.0.0.1:${PORT}/scoreboard`);
  console.log(`[bench-bridge] model=${process.env.BENCH_MODEL || "sonnet"}  cli=${process.env.BENCH_CLAUDE_CLI || "(auto)"}`);
});
