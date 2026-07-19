import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "../../src/process-tree-kill.js";
import { qualificationChildEnv } from "./child-env.js";

import type {
  CertificationResult,
  ChatResult,
  CompactionResult,
  QualificationDriver,
  RuntimeStatus,
} from "./types.js";

const MARKER = "LAX_QUALIFICATION_CONTINUITY_7F31";
const READ_NONCE = "LAX_QUALIFICATION_READ_8C42";
const REQUEST_TIMEOUT_MS = 180_000;
const FORBIDDEN_CONTROL_EVENTS = new Set([
  "approval_requested",
  "approval_resolved",
  "approval_timeout",
  "secret_request",
  "secrets_request",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

interface LocalRuntimePayload {
  runtimes?: Array<{
    id: string;
    kind: string;
    models?: Array<{ id: string; digest?: string; certification?: { status?: string } }>;
  }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function isCertificationBody(body: Buffer): boolean {
  const value = body.toString("utf8");
  return value.includes("LAX_CERT_")
    || value.includes("lax_certification_probe")
    || value.includes('"name":"certification"');
}

function isCompactionBody(body: Buffer): boolean {
  return body.toString("utf8").includes("Conversation segment to summarize");
}

export class RealQualificationDriver implements QualificationDriver {
  readonly model: string;
  private readonly upstream: URL;
  private readonly repoRoot: string;
  private readonly root: string;
  private readonly dataDir: string;
  private readonly workspace: string;
  private readonly token = randomUUID().replaceAll("-", "");
  private readonly sessionId = `qualification-${randomUUID()}`;
  private proxy: Server | null = null;
  private child: ChildProcess | null = null;
  private proxyUrl = "";
  private laxUrl = "";
  private certificationCalls = 0;
  private backgroundRequests = 0;
  private pullRequests = 0;
  private expectCertificationRestore = false;
  private readonly onProxyUrl?: (url: string) => void;

  constructor(
    endpoint: string,
    model: string,
    repoRoot = resolve("."),
    options: { onOwnedRoot?(path: string): void; onProxyUrl?(url: string): void } = {},
  ) {
    this.upstream = new URL(endpoint);
    const host = this.upstream.hostname.toLowerCase();
    if (!new Set(["http:", "https:"]).has(this.upstream.protocol)
      || !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host)) {
      throw new Error("endpoint must be loopback http(s)");
    }
    this.model = model;
    this.repoRoot = repoRoot;
    this.root = mkdtempSync(join(tmpdir(), "lax-local-qualification-"));
    options.onOwnedRoot?.(this.root);
    this.onProxyUrl = options.onProxyUrl;
    this.dataDir = join(this.root, "data");
    this.workspace = join(this.root, "workspace");
  }

  async start(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.workspace, { recursive: true });
    writeFileSync(join(this.workspace, "qualification-note.txt"), `${READ_NONCE}\n`, "utf8");
    await this.startProxy();
    await this.startLax();
  }

  forbiddenPullRequests(): number {
    return this.pullRequests;
  }

  async status(): Promise<RuntimeStatus> {
    const deadline = Date.now() + 30_000;
    let last: RuntimeStatus | null = null;
    do {
      const payload = await this.json<LocalRuntimePayload>("GET", "/api/local-runtimes");
      for (const runtime of payload.runtimes ?? []) {
        if (runtime.kind !== "ollama") continue;
        const model = runtime.models?.find((candidate) => candidate.id === this.model);
        if (model) {
          last = {
            found: true,
            verified: model.certification?.status === "verified",
            runtimeId: runtime.id,
            digest: model.digest ?? null,
            certificationCalls: this.certificationCalls,
          };
          if (!this.expectCertificationRestore || last.verified) return last;
        }
      }
      await delay(250);
    } while (Date.now() < deadline);
    return last ?? { found: false, verified: false, runtimeId: "", digest: null, certificationCalls: this.certificationCalls };
  }

  async certify(runtimeId: string): Promise<CertificationResult> {
    const guarded = await fetch(`${this.laxUrl}/api/local-runtimes/certify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId, model: this.model }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const result = await this.json<{
      ok: boolean;
      passedCount: number;
      scenarioCount: number;
      callCount: number;
      scenarios?: Array<{ id?: unknown }>;
    }>("POST", "/api/local-runtimes/certify", { runtimeId, model: this.model });
    return {
      ...result,
      operatorGuarded: guarded.status === 401 || guarded.status === 403,
      scenarioIds: (result.scenarios ?? []).map((scenario) => String(scenario.id ?? "")),
    };
  }

  async chat(kind: "baseline" | "workspace-read" | "history" | "continuity"): Promise<ChatResult> {
    const prompts = {
      baseline: `Remember ${MARKER}. Reply with exactly READY.`,
      "workspace-read": `Use the read tool on workspace/qualification-note.txt. Then reply with exactly ${READ_NONCE}.`,
      history: `Keep remembering ${MARKER}. Reply with exactly ACK.`,
      continuity: `From the earlier compacted context, reply with the exact continuity marker and nothing else.`,
    } as const;
    const response = await fetch(`${this.laxUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ sessionId: this.sessionId, message: prompts[kind], attachments: [] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error(`chat failed: HTTP ${response.status}`);
    const events = await readSse(response);
    const text = events.filter((event) => event.type === "stream" && typeof event.delta === "string")
      .map((event) => String(event.delta)).join("");
    const starts = events.filter((event) => event.type === "tool_start" && event.toolName === "read");
    const ends = events.filter((event) => event.type === "tool_end" && event.toolName === "read");
    const lifecycle = starts.length === 1 && ends.length === 1
      && typeof starts[0].toolCallId === "string"
      && starts[0].toolCallId === ends[0].toolCallId
      && ends[0].allowed === true
      && ends[0].status === "ok";
    return {
      done: events.some((event) => event.type === "done"),
      hasText: text.trim().length > 0,
      errorEvents: events.filter((event) => event.type === "error").length,
      safeReadLifecycle: lifecycle,
      forbiddenControlEvents: events.filter((event) => FORBIDDEN_CONTROL_EVENTS.has(String(event.type))).length,
      readNonceSeen: text.includes(READ_NONCE),
      continuityMarkerSeen: text.includes(MARKER),
    };
  }

  async compact(): Promise<CompactionResult> {
    const before = this.backgroundRequests;
    const persistedMessageCount = this.readSessionRows().filter((row) => row.kind === "msg").length;
    const response = await this.json<{ ok: boolean }>("POST", "/api/compact", { sessionId: this.sessionId });
    const rows = this.readSessionRows();
    const summary = this.readPersistedSummary(rows);
    const leadingConversationRow = rows.find((row) => row.kind !== "meta");
    return {
      ok: response.ok,
      backgroundRequests: this.backgroundRequests - before,
      persistedMessageCount,
      persistedSummary: summary !== null,
      summaryIsLeading: leadingConversationRow?.kind === "summary"
        && typeof leadingConversationRow.content === "string"
        && leadingConversationRow.content.startsWith("[COMPACTED CONTEXT"),
      summaryContainsMarker: summary?.includes(MARKER) ?? false,
    };
  }

  async persistedSummary(): Promise<{ persisted: boolean; containsMarker: boolean }> {
    const summary = this.readPersistedSummary();
    return { persisted: summary !== null, containsMarker: summary?.includes(MARKER) ?? false };
  }

  async restart(): Promise<void> {
    await this.stopChild();
    this.expectCertificationRestore = true;
    await this.startLax();
  }

  async cleanup(): Promise<void> {
    let failed = false;
    try { await this.stopChild(); } catch { failed = true; }
    const proxy = this.proxy;
    this.proxy = null;
    if (proxy) {
      proxy.closeAllConnections();
      try { await new Promise<void>((resolveClose) => proxy.close(() => resolveClose())); }
      catch { failed = true; }
    }
    try { rmSync(this.root, { recursive: true, force: true }); } catch { failed = true; }
    if (failed) throw new Error("isolated qualification cleanup failed");
  }

  private async startProxy(): Promise<void> {
    this.proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const pathname = new URL(request.url ?? "/", this.upstream).pathname;
      if (pathname === "/api/pull") {
        this.pullRequests += 1;
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end('{"error":"forbidden"}');
        return;
      }
      if (request.method === "POST" && pathname.endsWith("/v1/chat/completions")) {
        if (isCertificationBody(body)) this.certificationCalls += 1;
      }
      if (request.method === "POST" && pathname.endsWith("/api/generate") && isCompactionBody(body)) {
        this.backgroundRequests += 1;
      }
      try {
        const target = new URL(request.url ?? "/", this.upstream);
        const upstream = await fetch(target, {
          method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).filter(
            ([name, value]) => typeof value === "string" && !HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
          )) as Record<string, string>,
          body: body.length > 0 ? body : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        response.writeHead(502).end();
      }
    });
    await new Promise<void>((resolveListen, reject) => {
      this.proxy!.once("error", reject);
      this.proxy!.listen(0, "127.0.0.1", resolveListen);
    });
    const address = this.proxy.address();
    const port = typeof address === "object" && address ? address.port : 0;
    this.proxyUrl = `http://127.0.0.1:${port}`;
    this.onProxyUrl?.(this.proxyUrl);
  }

  private async startLax(): Promise<void> {
    const port = await freePort();
    this.laxUrl = `http://127.0.0.1:${port}`;
    writeFileSync(join(this.dataDir, "config.json"), JSON.stringify({
      authToken: this.token,
      port,
      workspace: this.workspace,
      ollamaUrl: this.proxyUrl,
      localOnlyMode: true,
    }), "utf8");
    writeFileSync(join(this.dataDir, "settings.json"), JSON.stringify({ provider: "local", model: this.model }), "utf8");
    this.child = spawn(process.execPath, ["--import=tsx", "src/index.ts"], {
      cwd: this.repoRoot,
      windowsHide: true,
      stdio: "ignore",
      env: qualificationChildEnv(process.env, {
        HOME: this.root,
        USERPROFILE: this.root,
        NODE_ENV: "production",
        LAX_LOCAL_MODEL_QUALIFICATION_BOOT: "1",
        VITEST: "",
        LAX_DATA_DIR: this.dataDir,
        LAX_WORKSPACE: this.workspace,
        LAX_PORT: String(port),
        LAX_AUTH_TOKEN: this.token,
        LAX_PROBE_PARENT_PID: String(process.pid),
        LAX_OLLAMA_URL: this.proxyUrl,
        LAX_MODEL: this.model,
        LAX_BG_IDLE_THRESHOLD_MS: String(24 * 60 * 60 * 1000),
        LAX_LLM_INSTRUCTION_LEDGER: "0",
        LAX_LLM_CLEANUP_VERIFY: "0",
        LAX_LLM_OPERATIONAL_CLAIM: "0",
      }),
    });
    await this.waitForHealth();
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null) throw new Error("isolated LAX process exited during boot");
      try {
        const response = await fetch(`${this.laxUrl}/api/health`, { headers: this.headers(), signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      } catch { /* keep polling */ }
      await delay(250);
    }
    throw new Error("isolated LAX health check timed out");
  }

  private async stopChild(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) { this.child = null; return; }
    const child = this.child;
    const exited = new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true)));
    killProcessTree(child, "SIGTERM");
    const graceful = await Promise.race([exited, delay(5_000).then(() => false)]);
    if (!graceful && child.exitCode === null) {
      killProcessTree(child, "SIGKILL");
      const forced = await Promise.race([exited, delay(5_000).then(() => false)]);
      if (!forced && child.exitCode === null) throw new Error("isolated LAX process did not exit");
    }
    this.child = null;
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.laxUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
    return await response.json() as T;
  }

  private readSessionRows(): Array<{ kind?: string; content?: string }> {
    const path = join(this.dataDir, "sessions", `${this.sessionId}.jsonl`);
    try {
      return readFileSync(path, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { kind?: string; content?: string });
    } catch {
      return [];
    }
  }

  private readPersistedSummary(rows = this.readSessionRows()): string | null {
    return [...rows].reverse().find((row) => row.kind === "summary")?.content ?? null;
  }
}

async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      try { events.push(JSON.parse(line.slice(6)) as Record<string, unknown>); } catch { /* ignore malformed frame */ }
    }
  }
  return events;
}
