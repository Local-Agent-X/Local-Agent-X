/**
 * Warm-pool of long-lived `claude -p --input-format=stream-json` processes.
 *
 * Validated by `scripts/spike-claude-warm-pool.mjs`: the CLI accepts
 * multiple consecutive prompts via stdin JSON-lines without re-spawning.
 * Cold start (~2-4s) is paid once per process; warm turns drop first-byte
 * latency from ~2000ms to ~4ms.
 *
 * Two pool modes:
 *   - **Text-only** (no sessionId, no MCP): processes are interchangeable
 *     across sessions. Keyed by `(model, permissionMode)`. Used when the
 *     caller passes `tools=[]`.
 *   - **Tool / MCP** (sessionId present): one warm process per session.
 *     The MCP bridge subprocess that the CLI spawns at startup carries
 *     `LAX_MCP_SESSION_ID` so its `/api/mcp/call` POSTs route side-effects
 *     to the right WebSocket. That binding is fixed at spawn → can't be
 *     shared across sessions, hence per-session keying. Pool size still 1
 *     per (model, permissionMode, sessionId) tuple.
 *
 * Lifecycle:
 *   - `acquire()` returns an idle process or spawns one if pool not full.
 *   - `streamPrompt()` locks the process, writes one JSON-line to stdin,
 *     reads stdout until the `result` frame, yields StreamEvents, releases.
 *   - Abort signal kills the process (CLI has no in-band abort). Killed
 *     processes are evicted; pool refills lazily on next acquire.
 *   - Idle processes evict after 5 minutes; bounded resource use.
 *
 * Behind `LAX_CLAUDE_WARM_POOL=1`. When unset, callers fall back to the
 * per-request `streamViaCliWithTools` path unchanged.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { npmAugmentedEnv } from "./cli-path.js";
import type { StreamEvent } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("anthropic-client.warm-pool");

// 30 min idle eviction. Real chat has long natural pauses (think, coffee,
// distraction). The earlier 5-min cap was killing warm processes between
// every "long pause" follow-up — the user paid cold start (~3s) on the
// turn AFTER any break. 30 min covers normal chat rhythm; on actual sleep
// the pool drains naturally and the next session warmups are fast.
const IDLE_EVICT_MS = 30 * 60 * 1000;
const MAX_PROCESSES_PER_KEY = 3;

type PermissionMode = "plan" | "bypassPermissions" | "auto" | "default";

export interface WarmPoolKey {
  model: string;
  permissionMode: PermissionMode;
  /**
   * When set, the warm process is bound to this chat session: it spawns
   * an MCP bridge with `LAX_MCP_SESSION_ID=sessionId`, so tool calls'
   * side-effects route to the right WebSocket. Unset = text-only pool.
   */
  sessionId?: string;
  /** Required when sessionId is set. */
  saxPort?: number;
  /** Required when sessionId is set. */
  saxToken?: string;
}

interface WarmProcess {
  proc: ChildProcessWithoutNullStreams;
  key: string;
  state: "idle" | "busy" | "dead";
  lastUsedAt: number;
  spawnedAt: number;
  // Stdout demux: a single pump reads stdout, parsed JSON frames are routed
  // to the active prompt's listener. When idle, frames are ignored
  // (shouldn't happen; CLI is silent between prompts).
  activeListener: ((frame: unknown) => void) | null;
  buffer: string;
  stderr: string;
  /** Path to a generated MCP config file, deleted on process exit. */
  mcpConfigPath: string | null;
}

const DISALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "TodoWrite", "ToolSearch",
  "NotebookEdit", "Task", "AskUserQuestion", "Skill",
  "CronCreate", "CronDelete", "CronList",
  "EnterPlanMode", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "Monitor", "TaskOutput", "TaskStop",
  "ScheduleWakeup", "PushNotification", "RemoteTrigger",
].join(",");

function writeMcpConfig(sessionId: string, port: number, token: string): string {
  const tmpDir = join(homedir(), ".lax", "tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const configPath = join(tmpDir, `mcp-warmpool-${sessionId}.json`);
  // Bridge is TypeScript — try compiled .js first, fall back to .ts via tsx.
  const here = (import.meta.dirname || ".");
  const tsPath = resolve(join(here, "..", "mcp-bridge.ts"));
  const jsPath = resolve(join(here, "..", "mcp-bridge.js"));
  const bridgePath = existsSync(jsPath) ? jsPath : tsPath;
  const needsTsx = bridgePath.endsWith(".ts");
  const mcpConfig = {
    mcpServers: {
      lax: {
        command: "node",
        args: needsTsx ? ["--import=tsx", bridgePath] : [bridgePath],
        env: {
          LAX_MCP_URL: `http://127.0.0.1:${port}`,
          LAX_MCP_TOKEN: token,
          LAX_MCP_SESSION_ID: sessionId,
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  return configPath;
}

const pool = new Map<string, WarmProcess[]>();
const waiters = new Map<string, Array<() => void>>();
let evictTimer: ReturnType<typeof setInterval> | null = null;

function keyStr(k: WarmPoolKey): string {
  return `${k.model}::${k.permissionMode}::${k.sessionId ?? "shared"}`;
}

function startEvictLoop(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, procs] of pool) {
      const survivors = procs.filter((p) => {
        if (p.state === "dead") return false;
        if (p.state === "idle" && now - p.lastUsedAt > IDLE_EVICT_MS) {
          logger.info(`[warm-pool] evicting idle process key=${key} age=${Math.round((now - p.spawnedAt) / 1000)}s`);
          try { p.proc.kill("SIGTERM"); } catch { /* already dead */ }
          p.state = "dead";
          return false;
        }
        return true;
      });
      if (survivors.length === 0) pool.delete(key);
      else pool.set(key, survivors);
    }
  }, 60_000);
  evictTimer.unref?.();
}

export function isWarmPoolEnabled(): boolean {
  const raw = (process.env.LAX_CLAUDE_WARM_POOL ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function spawnWarmProcess(key: WarmPoolKey): WarmProcess {
  const args = [
    "-p",
    "--model", key.model,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
    "--no-session-persistence",
    "--permission-mode", key.permissionMode,
    "--verbose",
    // Block ALL Claude Code native tools regardless of MCP/text-only mode.
    // Without this, plan mode still leaks the model into emitting Read/Bash/
    // Glob/Grep/AskUserQuestion calls — the user sees the agent "exploring"
    // their filesystem on a "hi". Local Agent X's own tools are surfaced via
    // MCP (when MCP is wired below); the native set is always off.
    "--disallowed-tools", DISALLOWED_TOOLS,
  ];

  // MCP bridge wiring: required when this pool entry is bound to a chat
  // session. The bridge subprocess is spawned by the CLI itself and stays
  // alive for the lifetime of the warm process — no per-turn bridge cold
  // start. This is the bigger win for tool-using turns (saves ~600ms per
  // turn, compounds across the session).
  let mcpConfigPath: string | null = null;
  if (key.sessionId && key.saxPort && key.saxToken) {
    try {
      mcpConfigPath = writeMcpConfig(key.sessionId, key.saxPort, key.saxToken);
      args.push("--mcp-config", mcpConfigPath);
    } catch (e) {
      logger.warn(`[warm-pool] MCP config setup failed for sess=${key.sessionId}: ${(e as Error).message}`);
      mcpConfigPath = null;
    }
  }

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: npmAugmentedEnv(),
  }) as ChildProcessWithoutNullStreams;

  const wp: WarmProcess = {
    proc,
    key: keyStr(key),
    state: "idle",
    lastUsedAt: Date.now(),
    spawnedAt: Date.now(),
    activeListener: null,
    buffer: "",
    stderr: "",
    mcpConfigPath,
  };

  proc.stderr?.on("data", (chunk: Buffer) => {
    wp.stderr += chunk.toString();
    if (wp.stderr.length > 4096) wp.stderr = wp.stderr.slice(-2048);
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    wp.buffer += chunk.toString();
    const lines = wp.buffer.split("\n");
    wp.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { continue; }
      if (wp.activeListener) wp.activeListener(frame);
    }
  });

  proc.on("exit", (code) => {
    wp.state = "dead";
    if (wp.mcpConfigPath) {
      try { unlinkSync(wp.mcpConfigPath); } catch { /* already gone */ }
    }
    logger.info(`[warm-pool] process exited code=${code} key=${wp.key} age=${Math.round((Date.now() - wp.spawnedAt) / 1000)}s stderr_tail=${wp.stderr.slice(-200)}`);
    // Wake any waiters — they'll retry acquire and either get another idle
    // process or trigger a fresh spawn.
    const ws = waiters.get(wp.key);
    if (ws) {
      const w = ws.shift();
      if (w) w();
    }
  });

  proc.on("error", (e) => {
    logger.warn(`[warm-pool] spawn error key=${wp.key}: ${e.message}`);
    wp.state = "dead";
  });

  startEvictLoop();
  logger.info(`[warm-pool] spawned new process key=${wp.key}`);
  return wp;
}

async function acquire(key: WarmPoolKey): Promise<WarmProcess> {
  const k = keyStr(key);
  const procs = pool.get(k) ?? [];

  // Find an idle, alive process
  for (const p of procs) {
    if (p.state === "idle") {
      p.state = "busy";
      return p;
    }
  }

  // No idle process — spawn a fresh one if under the cap
  if (procs.length < MAX_PROCESSES_PER_KEY) {
    const wp = spawnWarmProcess(key);
    wp.state = "busy";
    pool.set(k, [...procs, wp]);
    return wp;
  }

  // At cap, all busy — wait for one to free
  await new Promise<void>((resolve) => {
    const ws = waiters.get(k) ?? [];
    ws.push(resolve);
    waiters.set(k, ws);
  });
  return acquire(key);
}

function release(wp: WarmProcess): void {
  if (wp.state === "dead") {
    // Drop from pool; waiters will trigger respawn on next acquire
    const procs = pool.get(wp.key);
    if (procs) pool.set(wp.key, procs.filter((p) => p !== wp));
  } else {
    wp.state = "idle";
    wp.lastUsedAt = Date.now();
  }
  const ws = waiters.get(wp.key);
  if (ws) {
    const w = ws.shift();
    if (w) w();
  }
}

interface WarmPromptOptions {
  prompt: string;
  signal?: AbortSignal;
}

/**
 * Send one prompt to a warm CLI process and yield StreamEvents. The wire
 * format mirrors stream-cli.ts so callers can swap paths transparently.
 *
 * Per-prompt protocol (validated by the spike):
 *   stdin  : `{"type":"user","message":{"role":"user","content":"..."}}\n`
 *   stdout : sequence of JSON frames ending with `{"type":"result", ...}`
 */
export async function* streamViaWarmPool(
  key: WarmPoolKey,
  opts: WarmPromptOptions,
): AsyncGenerator<StreamEvent> {
  const wp = await acquire(key);
  let released = false;
  let aborted = false;
  // Two abort modes, distinguished by the AbortSignal's `reason`:
  //   - reason matches /idle|stalled|stop/i → KILL the warm process. The
  //     model is wedged or the user pressed stop; we need to free the
  //     subprocess so it stops burning Anthropic tokens.
  //   - any other reason (or no reason) → DRAIN silently. This is the
  //     gentle path for session-turn-lock evictions and similar internal
  //     cleanup — preserves the warm process for the next turn.
  const onAbort = () => {
    aborted = true;
    const reason = opts.signal?.reason;
    const reasonText =
      reason instanceof Error ? reason.message :
      typeof reason === "string" ? reason : "";
    if (/idle|stalled|stop/i.test(reasonText)) {
      try { wp.proc.kill("SIGKILL"); } catch { /* dead */ }
      wp.state = "dead";
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const queue: unknown[] = [];
    let resolveNext: ((v: { done: boolean; frame?: unknown }) => void) | null = null;
    let finished = false;

    wp.activeListener = (frame: unknown) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ done: false, frame });
      } else {
        queue.push(frame);
      }
    };

    const userMsg = JSON.stringify({
      type: "user",
      message: { role: "user", content: opts.prompt },
    }) + "\n";
    wp.proc.stdin.write(userMsg);

    let fullText = "";
    let usage: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    } = {};

    while (!finished) {
      let next: { done: boolean; frame?: unknown };
      if (queue.length > 0) {
        next = { done: false, frame: queue.shift() };
      } else if (wp.state === "dead") {
        yield { type: "error", error: `warm process died: ${wp.stderr.slice(-300)}` };
        return;
      } else {
        next = await new Promise((r) => { resolveNext = r; });
      }
      if (next.done) break;
      const frame = next.frame as Record<string, unknown>;
      const t = frame.type as string | undefined;
      // If the consumer aborted, drain frames silently until the CLI's
      // natural `result` arrives. We MUST keep reading stdout — otherwise
      // the next acquired prompt would race the old turn's tail and the
      // CLI's stdin/stdout demux gets confused. Suppressing yields keeps
      // the consumer clean; suppressing the early return keeps the
      // process reusable.
      if (aborted) {
        if (t === "result") {
          finished = true;
          break;
        }
        continue;
      }

      // stream_event with content_block_delta → text deltas
      if (t === "stream_event") {
        const inner = frame.event as Record<string, unknown> | undefined;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            fullText += delta.text;
            yield { type: "text", delta: delta.text };
          }
        }
        continue;
      }

      // assistant frame may contain tool_use blocks. MCP-prefixed names are
      // handled by the CLI's bridge subprocess (executed in-CLI; result fed
      // back automatically) — we just emit `mcp_activity` so the UI can
      // render an activity card. Non-MCP tool_use yields a `tool_call` event
      // so the agent loop can dispatch externally.
      if (t === "assistant") {
        const msg = frame.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
            const argStr = JSON.stringify(block.input ?? {});
            const name = block.name as string;
            if (name.startsWith("mcp__")) {
              yield { type: "mcp_activity", name, arguments: argStr };
            } else {
              const id = (typeof block.id === "string" && block.id) ? block.id : `${name}_${Date.now().toString(36)}`;
              yield { type: "tool_call", id, name, arguments: argStr };
            }
          }
        }
        continue;
      }

      // result frame = end of turn. Yield done and break.
      if (t === "result") {
        const u = frame.usage as Record<string, unknown> | undefined;
        if (u && typeof u === "object") usage = u as typeof usage;
        // DEBUG: inspect raw usage shape so we can see whether the CLI
        // surfaces cache_read_input_tokens / cache_creation_input_tokens
        // under OAuth subscription auth. Drop once cache fields are
        // confirmed in soak rows.
        try {
          logger.info(`[warm-pool] usage-keys=${Object.keys(usage).join(",")} usage-json=${JSON.stringify(usage).slice(0, 500)}`);
        } catch { /* ignore */ }
        // If no streamed deltas arrived (no --include-partial-messages
        // support, or the model emitted a single content block), back-fill
        // from result text.
        const resultText = typeof frame.result === "string" ? frame.result : "";
        if (resultText.length > fullText.length) {
          const tail = resultText.slice(fullText.length);
          if (tail.length > 0) yield { type: "text", delta: tail };
        }
        yield {
          type: "done",
          usage: {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheCreateTokens: usage.cache_creation_input_tokens,
          },
        };
        finished = true;
        break;
      }

      // Other frames (system, user-replay, assistant, rate_limit_event) —
      // ignored. The text deltas already covered content; the assistant
      // frame would re-emit the full text we've already streamed.
    }
  } finally {
    wp.activeListener = null;
    if (!released) {
      released = true;
      release(wp);
    }
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}

/** Test/shutdown hook — kills every warm process and clears state. */
export function shutdownWarmPool(): void {
  for (const [, procs] of pool) {
    for (const p of procs) {
      try { p.proc.kill("SIGTERM"); } catch { /* dead */ }
      p.state = "dead";
    }
  }
  pool.clear();
  waiters.clear();
  if (evictTimer) { clearInterval(evictTimer); evictTimer = null; }
}

/** Telemetry / introspection. */
export function warmPoolSnapshot(): Array<{ key: string; idle: number; busy: number; dead: number }> {
  const out: Array<{ key: string; idle: number; busy: number; dead: number }> = [];
  for (const [key, procs] of pool) {
    out.push({
      key,
      idle: procs.filter((p) => p.state === "idle").length,
      busy: procs.filter((p) => p.state === "busy").length,
      dead: procs.filter((p) => p.state === "dead").length,
    });
  }
  return out;
}
