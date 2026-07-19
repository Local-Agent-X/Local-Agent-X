import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const CONTINUITY_MARKER = "LAX_QUALIFICATION_CONTINUITY_7F31";
const READ_NONCE = "LAX_QUALIFICATION_READ_8C42";

interface WireMessage {
  role?: string;
  content?: unknown;
}

interface CompletionBody {
  messages?: WireMessage[];
  response_format?: unknown;
  tools?: Array<{ function?: { name?: string } }>;
  stream?: boolean;
  prompt?: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) });
  res.end(encoded);
}

async function bodyOf(req: IncomingMessage): Promise<CompletionBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CompletionBody;
}

function message(content: string, toolCalls?: unknown[]): unknown {
  return {
    id: "fake-completion",
    object: "chat.completion",
    created: 1,
    model: "qualification-fake:1b",
    choices: [{
      index: 0,
      message: { role: "assistant", content: toolCalls ? null : content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): unknown {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function stream(res: ServerResponse, content: string, call?: { id: string; name: string; args: Record<string, unknown> }): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const delta = call
    ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall(call.id, call.name, call.args) }] }
    : { role: "assistant", content };
  res.write(`data: ${JSON.stringify({
    id: "fake-stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "qualification-fake:1b",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: "fake-stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "qualification-fake:1b",
    choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
  })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function contentText(message: WireMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

export class FakeOllamaQualificationService {
  readonly model = "qualification-fake:1b";
  readonly digest = "sha256:qualification-fake";
  readonly counts = { version: 0, tags: 0, ps: 0, show: 0, generate: 0, completion: 0, forbidden: 0 };
  readonly received: string[] = [];
  private server: Server | null = null;
  private baseUrl = "";
  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.received.push(`${req.method ?? ""} ${req.url ?? ""}`);
    if (req.headers["x-qualification-test-redirect"] === "1") {
      res.writeHead(307, { Location: "http://127.0.0.1:1/redirected" }).end();
      return;
    }
    const path = new URL(req.url ?? "/", this.baseUrl).pathname;
    if (req.method === "GET" && path === "/api/version") {
      this.counts.version += 1;
      return json(res, 200, { version: "qualification-fake-1" });
    }
    if (req.method === "GET" && path === "/api/tags") {
      this.counts.tags += 1;
      return json(res, 200, { models: [{ name: this.model, digest: this.digest, size: 1, capabilities: ["completion", "tools"] }] });
    }
    if (req.method === "GET" && path === "/api/ps") {
      this.counts.ps += 1;
      return json(res, 200, { models: [{ name: this.model, context_length: 32_768 }] });
    }
    if (req.method === "POST" && path === "/api/show") {
      this.counts.show += 1;
      await bodyOf(req);
      return json(res, 200, { parameters: "num_ctx 32768", capabilities: ["completion", "tools"] });
    }
    if (req.method === "POST" && path === "/api/generate") {
      this.counts.generate += 1;
      const body = await bodyOf(req);
      if (!body.prompt?.includes("Conversation segment to summarize")) {
        return json(res, 200, { response: "{}" });
      }
      const marker = body.prompt?.includes(CONTINUITY_MARKER)
        ? `\n- Preserve ${CONTINUITY_MARKER}.`
        : "";
      return json(res, 200, {
        response: `CONSTRAINTS:${marker}\nCURRENT_TASK_STATE:\n- Qualification continuity is active.`,
      });
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      this.counts.completion += 1;
      const body = await bodyOf(req);
      return this.completion(body, res);
    }
    this.counts.forbidden += 1;
    json(res, 418, { error: "proxy_forwarded_forbidden_route" });
  }

  private completion(body: CompletionBody, res: ServerResponse): void {
    const messages = body.messages ?? [];
    const allText = messages.map(contentText).join("\n");
    const toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
    if (allText.includes("LAX_CERT_BASE_4D2F")) return json(res, 200, message("LAX_CERT_BASE_4D2F"));
    if (body.response_format) return json(res, 200, message('{"ok":true}'));
    if (toolNames.includes("lax_certification_probe")) {
      return json(res, 200, message("", [toolCall("cert-call", "lax_certification_probe", { ok: true })]));
    }
    if (allText.includes("LAX_CERT_CONT_91A7")) return json(res, 200, message("LAX_CERT_CONT_91A7"));
    if (allText.includes("LAX_CERT_CTX_62CE")) return json(res, 200, message("LAX_CERT_CTX_62CE"));
    if (!body.stream && toolNames.includes("ping")) {
      return json(res, 200, message("", [toolCall("ping-call", "ping", {})]));
    }

    const latestUser = [...messages].reverse().find((entry) => entry.role === "user");
    const userText = latestUser ? contentText(latestUser) : "";
    if (userText.includes("qualification-note.txt")) {
      const hasReadNonceResult = messages.some((entry) => (
        entry.role === "tool" && contentText(entry).includes(READ_NONCE)
      ));
      if (hasReadNonceResult) return stream(res, READ_NONCE);
      return stream(res, "", { id: "read-call-1", name: "read", args: { path: "workspace/qualification-note.txt" } });
    }
    if (userText.includes("earlier compacted context")) {
      const priorText = messages.slice(0, -1).map(contentText).join("\n");
      return stream(res, priorText.includes(CONTINUITY_MARKER) ? CONTINUITY_MARKER : "NO_COMPACTED_CONTEXT");
    }
    if (userText.includes("Reply with exactly READY")) return stream(res, "READY");
    if (userText.includes("Reply with exactly ACK")) return stream(res, "ACK");
    stream(res, "OK");
  }
}
