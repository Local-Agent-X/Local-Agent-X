import { RealQualificationDriver } from "../../scripts/local-qualification/real-driver.js";
import type { QualificationChatKind } from "../../scripts/local-qualification/chat-evidence.js";
import type { QualificationStageName } from "../../scripts/local-qualification/types.js";

export class FailingRealQualificationDriver extends RealQualificationDriver {
  private certified = false;

  constructor(
    endpoint: string,
    model: string,
    repoRoot: string,
    options: ConstructorParameters<typeof RealQualificationDriver>[3],
    private readonly failAt: QualificationStageName,
  ) {
    super(endpoint, model, repoRoot, options);
  }

  override async start(signal: AbortSignal): Promise<void> {
    await super.start(signal);
    this.fail("isolated_boot");
  }

  override async status(signal: AbortSignal) {
    const result = await super.status(signal);
    this.fail(this.certified ? "status_reads" : "passive_pre_certification");
    return result;
  }

  override async certify(runtimeId: string, signal: AbortSignal) {
    const result = await super.certify(runtimeId, signal);
    this.certified = true;
    this.fail("operator_certification");
    return result;
  }

  override async chat(kind: QualificationChatKind, signal: AbortSignal) {
    const result = await super.chat(kind, signal);
    if (kind === "baseline") this.fail("chat_sse");
    if (kind === "workspace-read") this.fail("workspace_read");
    if (kind === "continuity") this.fail("continuity");
    return result;
  }

  override async compact(signal: AbortSignal) {
    const result = await super.compact(signal);
    this.fail("compaction");
    return result;
  }

  override async restart(signal: AbortSignal): Promise<void> {
    await super.restart(signal);
    this.fail("restart_restore");
  }

  private fail(stage: QualificationStageName): void {
    if (this.failAt === stage) throw new Error(`injected ${stage} failure`);
  }
}
