import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runQualificationCli, sanitizedScorecard } from "../scripts/local-qualification/cli.js";
import { qualificationChildEnv } from "../scripts/local-qualification/child-env.js";
import { RealQualificationDriver } from "../scripts/local-qualification/real-driver.js";
import { readQualificationConfig, runQualification } from "../scripts/local-qualification/run.js";
import type {
  CertificationResult,
  ChatResult,
  CompactionResult,
  QualificationDriver,
  QualificationStageName,
  RuntimeStatus,
} from "../scripts/local-qualification/types.js";
import { FakeOllamaQualificationService } from "./helpers/fake-ollama-qualification.js";

const STAGES: QualificationStageName[] = [
  "isolated_boot", "passive_pre_certification", "operator_certification", "status_reads",
  "chat_sse", "workspace_read", "compaction", "restart_restore", "continuity",
];

const SCENARIOS = [
  "baseline_marker", "strict_json_schema", "required_tool_call",
  "tool_result_continuation", "context_degradation",
];

function repoSurface(): unknown {
  const workspace = resolve("workspace");
  let workspaceState: unknown = { kind: "absent" };
  try {
    const stat = lstatSync(workspace);
    workspaceState = stat.isSymbolicLink()
      ? { kind: "link", target: readlinkSync(workspace), mtimeMs: stat.mtimeMs }
      : {
          kind: stat.isDirectory() ? "directory" : "file",
          mtimeMs: stat.mtimeMs,
          entries: stat.isDirectory() ? readdirSync(workspace).sort() : undefined,
        };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifest = join(resolve("."), "config", "app-manifest.json");
  const manifestStat = statSync(manifest);
  return {
    workspace: workspaceState,
    manifest: { bytes: readFileSync(manifest).toString("base64"), mtimeMs: manifestStat.mtimeMs },
  };
}

class FakeDriver implements QualificationDriver {
  readonly model = "qualification-fake:1b";
  cleanupCalls = 0;
  private verified = false;
  private restarted = false;
  private certCalls = 0;

  constructor(
    private readonly failAt?: QualificationStageName | "cleanup",
    private readonly hangAt?: QualificationStageName | "cleanup",
  ) {}

  forbiddenPullRequests(): number { return 0; }

  async start(): Promise<void> { await this.gate("isolated_boot"); }

  async status(): Promise<RuntimeStatus> {
    await this.gate(!this.verified
      ? "passive_pre_certification"
      : this.restarted ? "restart_restore" : "status_reads");
    return {
      found: true,
      verified: this.verified,
      runtimeId: "ollama@127.0.0.1:1",
      digest: "sha256:test",
      certificationCalls: this.certCalls,
    };
  }

  async certify(): Promise<CertificationResult> {
    await this.gate("operator_certification");
    this.verified = true;
    this.certCalls = 5;
    return {
      ok: true,
      operatorGuarded: true,
      passedCount: 5,
      scenarioCount: 5,
      callCount: 5,
      scenarioIds: SCENARIOS,
    };
  }

  async chat(kind: "baseline" | "workspace-read" | "history" | "continuity"): Promise<ChatResult> {
    if (kind === "baseline") await this.gate("chat_sse");
    if (kind === "workspace-read") await this.gate("workspace_read");
    if (kind === "continuity") await this.gate("continuity");
    return {
      done: true,
      hasText: true,
      errorEvents: 0,
      safeReadLifecycle: kind === "workspace-read",
      forbiddenControlEvents: 0,
      readNonceSeen: kind === "workspace-read",
      continuityMarkerSeen: kind === "continuity",
    };
  }

  async compact(): Promise<CompactionResult> {
    await this.gate("compaction");
    return {
      ok: true,
      backgroundRequests: 1,
      persistedMessageCount: 12,
      persistedSummary: true,
      summaryIsLeading: true,
      summaryContainsMarker: true,
    };
  }

  async persistedSummary(): Promise<{ persisted: boolean; containsMarker: boolean }> {
    return { persisted: true, containsMarker: true };
  }

  async restart(): Promise<void> {
    await this.gate("restart_restore");
    this.restarted = true;
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
    if (this.hangAt === "cleanup") await new Promise<void>(() => {});
    if (this.failAt === "cleanup") throw new Error("sensitive cleanup detail");
  }

  private async gate(stage: QualificationStageName): Promise<void> {
    if (this.hangAt === stage) await new Promise<void>(() => {});
    if (this.failAt === stage) throw new Error("sensitive stage detail");
  }
}

class ObservedRealDriver extends RealQualificationDriver {
  lastChat: ChatResult | null = null;
  lastCompaction: CompactionResult | null = null;

  override async chat(kind: "baseline" | "workspace-read" | "history" | "continuity"): Promise<ChatResult> {
    this.lastChat = await super.chat(kind);
    return this.lastChat;
  }

  override async compact(): Promise<CompactionResult> {
    this.lastCompaction = await super.compact();
    return this.lastCompaction;
  }
}

describe("local model qualification workflow", () => {
  it("requires the explicit real-runtime gate, endpoint, and installed model tag", () => {
    expect(() => readQualificationConfig({})).toThrow(/required/);
    expect(() => readQualificationConfig({
      LAX_REAL_LOCAL_MODEL: "1",
      LAX_REAL_LOCAL_ENDPOINT: "http://127.0.0.1:11434",
    })).toThrow(/required/);
    expect(readQualificationConfig({
      LAX_REAL_LOCAL_MODEL: "1",
      LAX_REAL_LOCAL_ENDPOINT: "http://127.0.0.1:11434",
      LAX_REAL_LOCAL_MODEL_TAG: "already-installed:1b",
    })).toEqual({ endpoint: "http://127.0.0.1:11434", model: "already-installed:1b" });
    expect(() => readQualificationConfig({
      LAX_REAL_LOCAL_MODEL: "1",
      LAX_REAL_LOCAL_ENDPOINT: "https://example.com",
      LAX_REAL_LOCAL_MODEL_TAG: "already-installed:1b",
    })).toThrow(/loopback/);
    expect(() => new RealQualificationDriver("https://example.com", "model")).toThrow(/loopback/);
  });

  it("returns exit 2 and usage without the explicit opt-in", async () => {
    const messages: string[] = [];
    const code = await runQualificationCli({}, {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    });
    expect(code).toBe(2);
    expect(messages.join("\n")).toMatch(/LAX_REAL_LOCAL_MODEL=1/);
    expect(messages.join("\n")).not.toMatch(/token|reply|sessionId|authorization/i);
  });

  it("sanitizes isolated-runner initialization failures", async () => {
    const messages: string[] = [];
    const code = await runQualificationCli({
      LAX_REAL_LOCAL_MODEL: "1",
      LAX_REAL_LOCAL_ENDPOINT: "http://127.0.0.1:11434",
      LAX_REAL_LOCAL_MODEL_TAG: "already-installed:1b",
    }, {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    }, { createDriver: () => { throw new Error("sensitive initialization detail"); } });
    expect(code).toBe(1);
    expect(messages.join("\n")).not.toContain("sensitive initialization detail");
  });

  it("does not inherit preload, desktop, or proxy environment into the product child", () => {
    const env = qualificationChildEnv({
      PATH: "safe-path",
      SystemRoot: "safe-root",
      NODE_OPTIONS: "--import=host-preload",
      NODE_PATH: "host-modules",
      HTTP_PROXY: "http://proxy.invalid",
      HTTPS_PROXY: "http://proxy.invalid",
      ALL_PROXY: "socks://proxy.invalid",
      ELECTRON_RUN_AS_NODE: "1",
    }, { LAX_DATA_DIR: "owned-data" });
    expect(env).toEqual({ PATH: "safe-path", SystemRoot: "safe-root", LAX_DATA_DIR: "owned-data" });
  });

  it("runs every stage and emits only fixed sanitized fields", async () => {
    const driver = new FakeDriver();
    const scorecard = sanitizedScorecard(await runQualification(driver));
    expect(scorecard.ok).toBe(true);
    expect(scorecard.stages.map((stage) => stage.name)).toEqual(STAGES);
    expect(scorecard.model).toEqual({ tag: "qualification-fake:1b", digest: "sha256:test" });
    expect(JSON.stringify(scorecard)).not.toMatch(/sensitive|prompt|content|authorization|response|sessionId/i);
    expect(driver.cleanupCalls).toBe(1);
  });

  it.each(STAGES)("fails closed at %s and still cleans owned state", async (stage) => {
    const surface = repoSurface();
    const driver = new FakeDriver(stage);
    const scorecard = await runQualification(driver);
    expect(scorecard.ok).toBe(false);
    expect(scorecard.stages.at(-1)).toMatchObject({ name: stage, ok: false, failure: "failed" });
    expect(JSON.stringify(scorecard)).not.toContain("sensitive stage detail");
    expect(driver.cleanupCalls).toBe(1);
    expect(repoSurface()).toEqual(surface);
  });

  it.each(STAGES)("times out at %s and still cleans owned state", async (stage) => {
    const surface = repoSurface();
    const driver = new FakeDriver(undefined, stage);
    const scorecard = await runQualification(driver, { stageTimeoutMs: 5 });
    expect(scorecard.ok).toBe(false);
    expect(scorecard.stages.at(-1)).toMatchObject({ name: stage, ok: false, failure: "timeout" });
    expect(driver.cleanupCalls).toBe(1);
    expect(repoSurface()).toEqual(surface);
  });

  it("aborts an in-flight stage and still cleans owned state", async () => {
    const surface = repoSurface();
    const controller = new AbortController();
    const driver = new FakeDriver(undefined, "isolated_boot");
    setTimeout(() => controller.abort(), 5);
    const scorecard = await runQualification(driver, { signal: controller.signal, stageTimeoutMs: 1_000 });
    expect(scorecard.stages[0]).toMatchObject({ failure: "aborted" });
    expect(driver.cleanupCalls).toBe(1);
    expect(repoSurface()).toEqual(surface);
  });

  it("does not report success when cleanup fails or times out", async () => {
    const failed = await runQualification(new FakeDriver("cleanup"));
    const timedOut = await runQualification(new FakeDriver(undefined, "cleanup"), { cleanupTimeoutMs: 5 });
    expect(failed.cleanup.ok).toBe(false);
    expect(timedOut.cleanup.ok).toBe(false);
    expect(failed.ok).toBe(false);
    expect(timedOut.ok).toBe(false);
  });

  it("does not fabricate summary, restored-history, or read-result evidence", async () => {
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    try {
      const summary = await fetch(`${endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Conversation segment to summarize without the cause" }),
      });
      expect(JSON.stringify(await summary.json())).not.toContain("LAX_QUALIFICATION_CONTINUITY_7F31");

      const continuity = await fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "From the earlier compacted context, reply with LAX_QUALIFICATION_CONTINUITY_7F31." }],
        }),
      });
      expect(await continuity.text()).not.toContain("LAX_QUALIFICATION_CONTINUITY_7F31");

      const workspace = await fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [
            { role: "user", content: "Use the read tool on workspace/qualification-note.txt, then say LAX_QUALIFICATION_READ_8C42." },
            { role: "tool", content: "read completed without the requested file content" },
          ],
        }),
      });
      expect(await workspace.text()).not.toContain("LAX_QUALIFICATION_READ_8C42");
    } finally {
      await service.close();
    }
  });

  it("rejects and counts pull traffic without forwarding it to Ollama", async () => {
    const surface = repoSurface();
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    let proxyUrl = "";
    class PullingDriver extends RealQualificationDriver {
      override async start(): Promise<void> {
        await super.start();
        await fetch(`${proxyUrl}/api/pull?stream=true`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: this.model, stream: true }),
        });
      }
    }
    try {
      const driver = new PullingDriver(endpoint, service.model, resolve("."), {
        onProxyUrl: (url) => { proxyUrl = url; },
      });
      const scorecard = await runQualification(driver, { stageTimeoutMs: 90_000 });
      expect(scorecard.ok).toBe(false);
      expect(scorecard.stages[0]).toMatchObject({ name: "isolated_boot", ok: false, failure: "failed" });
      expect(driver.forbiddenPullRequests()).toBe(1);
      expect(service.counts.pull).toBe(0);
      expect(JSON.stringify(scorecard)).not.toMatch(/pull\?|proxy_forwarded|name.*stream/i);
      expect(repoSurface()).toEqual(surface);
    } finally {
      await service.close();
    }
  }, 180_000);

  it("qualifies the actual product routes against a deterministic fake Ollama service", async () => {
    const surface = repoSurface();
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    let ownedRoot = "";
    try {
      const driver = new ObservedRealDriver(endpoint, service.model, resolve("."), {
        onOwnedRoot: (path) => { ownedRoot = path; },
      });
      const scorecard = await runQualification(driver, { stageTimeoutMs: 90_000, cleanupTimeoutMs: 15_000 });
      expect(scorecard.ok, JSON.stringify({
        scorecard, lastChat: driver.lastChat, lastCompaction: driver.lastCompaction, counts: service.counts,
      })).toBe(true);
      expect(scorecard.stages.map((stage) => stage.name)).toEqual(STAGES);
      expect(scorecard.model.tag).toBe(service.model);
      expect(scorecard.cleanup.ok).toBe(true);
      expect(existsSync(ownedRoot)).toBe(false);
      expect(service.counts.pull).toBe(0);
      expect(repoSurface()).toEqual(surface);
    } finally {
      await service.close();
    }
  }, 180_000);
});
