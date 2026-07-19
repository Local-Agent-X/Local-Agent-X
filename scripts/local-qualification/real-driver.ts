import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "../../src/process-tree-kill.js";
import { qualificationChildEnv } from "./child-env.js";
import { chatEvidence, MARKER, qualificationPrompt, READ_NONCE, readSse, type QualificationChatKind } from "./chat-evidence.js";
import {
  delayWithSignal,
  freePort,
  requestSignal,
  throwIfAborted,
  waitForBarrier,
  type QualificationLifecycleOptions,
} from "./lifecycle-helpers.js";
import {
  startQualificationProxy,
  type QualificationProxy,
  type QualificationProxyCounters,
} from "./qualification-proxy.js";

import type {
  CertificationResult,
  ChatResult,
  CompactionResult,
  QualificationDriver,
  RuntimeStatus,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 180_000;

interface LocalRuntimePayload {
  runtimes?: Array<{
    id: string;
    kind: string;
    models?: Array<{ id: string; digest?: string; certification?: { status?: string } }>;
  }>;
}

export interface RealQualificationDriverOptions extends QualificationLifecycleOptions {
  onOwnedRoot?(path: string): void;
  onProxyUrl?(url: string): void;
  onForbiddenRoute?(request: string): void;
  childStdio?: "ignore" | "inherit";
  tsxImport?: string;
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
  private proxy: QualificationProxy | null = null;
  private child: ChildProcess | null = null;
  private proxyUrl = "";
  private laxUrl = "";
  private readonly counters: QualificationProxyCounters = { certification: 0, background: 0, forbidden: 0 };
  private expectCertificationRestore = false;
  private readonly options: RealQualificationDriverOptions;
  private closing = false;
  private generation = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lifecycleAbort: AbortController | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private restartPromise: Promise<void> | null = null;

  constructor(
    endpoint: string,
    model: string,
    repoRoot = resolve("."),
    options: RealQualificationDriverOptions = {},
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
    this.options = options;
    this.dataDir = join(this.root, "data");
    this.workspace = join(this.root, "workspace");
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.serializeLifecycle(async () => {
      const { generation, signal: lifecycleSignal } = this.beginLifecycle(signal);
      try {
        await waitForBarrier(this.options, "write", lifecycleSignal);
        this.assertOpen(generation, lifecycleSignal);
        mkdirSync(this.dataDir, { recursive: true });
        mkdirSync(this.workspace, { recursive: true });
        writeFileSync(join(this.workspace, "qualification-note.txt"), `${READ_NONCE}\n`, "utf8");
        await waitForBarrier(this.options, "proxy-bind", lifecycleSignal);
        this.assertOpen(generation, lifecycleSignal);
        const proxy = await startQualificationProxy(
          this.upstream, this.counters, lifecycleSignal, this.options.onForbiddenRoute,
        );
        if (!this.isOpen(generation, lifecycleSignal)) {
          await proxy.close();
          this.assertOpen(generation, lifecycleSignal);
        }
        this.proxy = proxy;
        this.proxyUrl = proxy.url;
        this.options.onProxyUrl?.(proxy.url);
        await this.startLax(generation, lifecycleSignal);
      } finally {
        this.endLifecycle();
      }
    });
  }

  forbiddenRequests(): number {
    return this.counters.forbidden;
  }

  async status(signal: AbortSignal): Promise<RuntimeStatus> {
    const deadline = Date.now() + 60_000;
    let last: RuntimeStatus | null = null;
    do {
      const payload = await this.json<LocalRuntimePayload>("GET", "/api/local-runtimes", undefined, signal);
      for (const runtime of payload.runtimes ?? []) {
        if (runtime.kind !== "ollama") continue;
        const model = runtime.models?.find((candidate) => candidate.id === this.model);
        if (model) {
          last = {
            found: true,
            verified: model.certification?.status === "verified",
            runtimeId: runtime.id,
            digest: model.digest ?? null,
            certificationCalls: this.counters.certification,
          };
          if (!this.expectCertificationRestore || last.verified) return last;
        }
      }
      await delayWithSignal(250, signal);
    } while (Date.now() < deadline);
    return last ?? { found: false, verified: false, runtimeId: "", digest: null, certificationCalls: this.counters.certification };
  }

  async certify(runtimeId: string, signal: AbortSignal): Promise<CertificationResult> {
    const guarded = await fetch(`${this.laxUrl}/api/local-runtimes/certify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId, model: this.model }),
      signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
    });
    const result = await this.json<{
      ok: boolean;
      passedCount: number;
      scenarioCount: number;
      callCount: number;
      scenarios?: Array<{ id?: unknown }>;
    }>("POST", "/api/local-runtimes/certify", { runtimeId, model: this.model }, signal);
    return {
      ...result,
      operatorGuarded: guarded.status === 401 || guarded.status === 403,
      scenarioIds: (result.scenarios ?? []).map((scenario) => String(scenario.id ?? "")),
    };
  }

  async chat(kind: QualificationChatKind, signal: AbortSignal): Promise<ChatResult> {
    const response = await fetch(`${this.laxUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ sessionId: this.sessionId, message: qualificationPrompt(kind), attachments: [] }),
      signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error(`chat failed: HTTP ${response.status}`);
    return chatEvidence(await readSse(response));
  }

  async compact(signal: AbortSignal): Promise<CompactionResult> {
    throwIfAborted(signal);
    const before = this.counters.background;
    const persistedMessageCount = this.readSessionRows().filter((row) => row.kind === "msg").length;
    const response = await this.json<{ ok: boolean }>("POST", "/api/compact", { sessionId: this.sessionId }, signal);
    const rows = this.readSessionRows();
    const summary = this.readPersistedSummary(rows);
    const leadingConversationRow = rows.find((row) => row.kind !== "meta");
    return {
      ok: response.ok,
      backgroundRequests: this.counters.background - before,
      persistedMessageCount,
      persistedSummary: summary !== null,
      summaryIsLeading: leadingConversationRow?.kind === "summary"
        && typeof leadingConversationRow.content === "string"
        && leadingConversationRow.content.startsWith("[COMPACTED CONTEXT"),
      summaryContainsMarker: summary?.includes(MARKER) ?? false,
    };
  }

  async persistedSummary(signal: AbortSignal): Promise<{ persisted: boolean; containsMarker: boolean }> {
    throwIfAborted(signal);
    const summary = this.readPersistedSummary();
    return { persisted: summary !== null, containsMarker: summary?.includes(MARKER) ?? false };
  }

  async restart(signal: AbortSignal): Promise<void> {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = this.serializeLifecycle(async () => {
      const { generation, signal: lifecycleSignal } = this.beginLifecycle(signal);
      try {
        await waitForBarrier(this.options, "restart", lifecycleSignal);
        await this.stopChild(lifecycleSignal, true);
        this.assertOpen(generation, lifecycleSignal);
        this.expectCertificationRestore = true;
        await this.startLax(generation, lifecycleSignal);
      } finally {
        this.endLifecycle();
      }
    }).finally(() => { this.restartPromise = null; });
    return this.restartPromise;
  }

  cleanup(_signal: AbortSignal): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closing = true;
    this.generation += 1;
    this.lifecycleAbort?.abort(new Error("qualification cleanup started"));
    this.cleanupPromise = this.serializeLifecycle(async () => {
      let failed = false;
      const neverAbort = new AbortController().signal;
      try { await this.stopChild(neverAbort, false); } catch { failed = true; }
      const proxy = this.proxy;
      this.proxy = null;
      if (proxy) {
        try { await proxy.close(); } catch { failed = true; }
      }
      try { rmSync(this.root, { recursive: true, force: true }); } catch { failed = true; }
      if (failed) throw new Error("isolated qualification cleanup failed");
    });
    return this.cleanupPromise;
  }

  private async startLax(generation: number, signal: AbortSignal): Promise<void> {
    await waitForBarrier(this.options, "free-port", signal);
    this.assertOpen(generation, signal);
    const port = await freePort(signal);
    this.assertOpen(generation, signal);
    this.laxUrl = `http://127.0.0.1:${port}`;
    await waitForBarrier(this.options, "write", signal);
    this.assertOpen(generation, signal);
    writeFileSync(join(this.dataDir, "config.json"), JSON.stringify({
      authToken: this.token,
      port,
      workspace: this.workspace,
      ollamaUrl: this.proxyUrl,
      localOnlyMode: true,
    }), "utf8");
    writeFileSync(join(this.dataDir, "settings.json"), JSON.stringify({ provider: "local", model: this.model }), "utf8");
    await waitForBarrier(this.options, "spawn", signal);
    this.assertOpen(generation, signal);
    const child = spawn(process.execPath, [`--import=${this.options.tsxImport ?? "tsx"}`, "src/index.ts"], {
      cwd: this.repoRoot,
      windowsHide: true,
      stdio: this.options.childStdio ?? "ignore",
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
    this.child = child;
    this.options.onChildSpawn?.(child.pid ?? 0);
    this.assertOpen(generation, signal);
    await waitForBarrier(this.options, "health", signal);
    await this.waitForHealth(generation, signal);
    this.assertOpen(generation, signal);
  }

  private async waitForHealth(generation: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      this.assertOpen(generation, signal);
      if (!this.child || this.child.exitCode !== null) throw new Error("isolated LAX process exited during boot");
      try {
        const response = await fetch(`${this.laxUrl}/api/health`, {
          headers: this.headers(),
          signal: requestSignal(signal, 1_000),
        });
        if (response.ok) return;
      } catch {
        throwIfAborted(signal);
      }
      await delayWithSignal(250, signal);
    }
    throw new Error("isolated LAX health check timed out");
  }

  private stopChild(signal: AbortSignal, useBarrier: boolean): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (useBarrier) await waitForBarrier(this.options, "stop", signal);
      const child = this.child;
      if (!child || child.exitCode !== null) { this.child = null; return; }
      const exited = new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true)));
      killProcessTree(child, "SIGTERM");
      const graceful = await Promise.race([exited, delayWithSignal(5_000, signal).then(() => false)]);
      if (!graceful && child.exitCode === null) {
        killProcessTree(child, "SIGKILL");
        const forced = await Promise.race([exited, delayWithSignal(5_000, signal).then(() => false)]);
        if (!forced && child.exitCode === null) throw new Error("isolated LAX process did not exit");
      }
      if (this.child === child) this.child = null;
    })().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private serializeLifecycle(run: () => Promise<void>): Promise<void> {
    const task = this.lifecycleTail.then(run, run);
    this.lifecycleTail = task.catch(() => {});
    return task;
  }

  private beginLifecycle(callerSignal: AbortSignal): { generation: number; signal: AbortSignal } {
    if (this.closing) throw new Error("qualification driver is closing");
    const controller = new AbortController();
    this.lifecycleAbort = controller;
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    const generation = this.generation;
    this.assertOpen(generation, signal);
    return { generation, signal };
  }

  private endLifecycle(): void {
    this.lifecycleAbort = null;
  }

  private isOpen(generation: number, signal: AbortSignal): boolean {
    return !this.closing && this.generation === generation && !signal.aborted;
  }

  private assertOpen(generation: number, signal: AbortSignal): void {
    throwIfAborted(signal);
    if (!this.isOpen(generation, signal)) throw new Error("qualification lifecycle generation closed");
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` };
  }

  private async json<T>(method: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await fetch(`${this.laxUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
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
