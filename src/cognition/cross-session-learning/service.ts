import type { ModuleSignal } from "../../orchestrator/types.js";
import { formatLearningCandidateNudge } from "../../memory/curate-nudge.js";
import {
  activateLearnedProtocol,
  archiveLearnedProtocol,
  hasLearnedProtocol,
  loadLearnedProtocol,
  restoreLearnedProtocol,
  rollbackLearnedProtocol,
  type LearnedProtocolRecord,
  type LearnedProtocolVersion,
} from "../../protocols/learned-lifecycle.js";
import {
  getVersionEffectiveness,
  listCommittedLearnedOutcomes,
} from "../../protocols/learned-effectiveness.js";
import {
  hasIndependentReviewedEvidence,
  selectSafetyRecovery,
} from "../../protocols/learned-refinement.js";
import { CrossSessionLearner, LearningPersistenceUnavailableError } from "./learner.js";
import { isReviewedProcedureCandidate, type LearnedCandidate } from "./types.js";
import { learningSummary, learningVersionView, type LearningAction, type LearningDetail, type LearningSummary } from "./service-views.js";

export interface LearningReconcileResult {
  signals: ModuleSignal[];
  changed: boolean;
}

export class CrossSessionLearningService {
  constructor(private readonly learner = CrossSessionLearner.getInstance()) {}

  list(): LearningSummary[] {
    this.learner.refresh();
    return this.learner.getCandidates().map((candidate) => learningSummary(candidate, this.recordFor(candidate.id)));
  }

  detail(id: string): LearningDetail | null {
    this.learner.refresh();
    const candidate = this.candidate(id);
    if (!candidate) return null;
    const record = this.recordFor(id);
    return {
      ...learningSummary(candidate, record),
      evidence: structuredClone(candidate.evidence),
      history: structuredClone(candidate.transitions),
      versions: record ? record.versions.map((version, index) => learningVersionView(version, index, record)) : [],
    };
  }

  action(id: string, input: LearningAction, now = Date.now()): LearningDetail {
    this.learner.refresh();
    const candidate = this.requireCandidate(id);
    if (input.action === "reject") {
      if (this.recordFor(id)?.state === "active") {
        throw new Error(`Active learned workflow must be archived, not rejected: ${id}`);
      }
      this.learner.setCandidateState(id, "rejected", "Rejected by user", now);
      return this.detail(id)!;
    }
    const record = this.requireRecord(id);
    if (input.action === "activate") {
      const versionId = input.versionId ?? this.newestVersion(record).id;
      if (isReviewedProcedureCandidate(candidate) && !this.hasToolEvidence(record, versionId)) {
        throw new Error(`Learned procedure has no tool evidence yet: ${id}`);
      }
      const active = activateLearnedProtocol({
        slug: id, versionId, expectedActiveVersionId: input.expectedActiveVersionId,
        reason: "Activated by user", timestamp: now,
      });
      this.projectState(candidate.id, active, now, "Activated by user");
    } else if (input.action === "archive") {
      const archived = archiveLearnedProtocol({
        slug: id, expectedActiveVersionId: input.expectedActiveVersionId,
        reason: "Archived by user", timestamp: now,
      });
      this.projectState(candidate.id, archived, now, "Archived by user");
    } else if (input.action === "restore") {
      const active = restoreLearnedProtocol({
        slug: id, expectedActiveVersionId: input.expectedActiveVersionId,
        reason: "Restored by user", timestamp: now,
      });
      this.projectState(candidate.id, active, now, "Restored by user");
    } else {
      const active = rollbackLearnedProtocol({
        slug: id,
        versionId: input.versionId,
        expectedActiveVersionId: input.expectedActiveVersionId,
        reason: "Rolled back by user",
        timestamp: now,
      });
      this.projectState(id, active, now, "Rollback reconciled");
    }
    return this.detail(id)!;
  }

  /** Keeps the lifecycle record and the candidate projection agreeing, runs
   *  the probation monitor on active versions, resumes an approval a crash
   *  interrupted, and activates a reviewed procedure on independent evidence.
   *  It never drafts: a draft enters only through createLearnedProtocolDraft's
   *  admission rule, and a candidate whose record is missing stays without one. */
  reconcile(now = Date.now()): LearningReconcileResult {
    this.learner.refresh();
    let changed = false;
    const signals: ModuleSignal[] = [];

    for (let candidate of this.learner.getCandidates()) {
      let record = this.recordFor(candidate.id);
      if (!record) continue;
      if (["rejected", "rolled-back"].includes(candidate.state) && record.state !== "active") continue;
      if (record.state === "active") {
        const recovery = this.safetyRecovery(record);
        if (recovery?.kind === "rollback") {
          record = rollbackLearnedProtocol({
            slug: candidate.id,
            versionId: recovery.targetVersionId,
            expectedActiveVersionId: record.activeVersionId,
            reason: recovery.reason,
            cause: recovery.cause,
            timestamp: now,
          });
          changed = this.projectState(candidate.id, record, now, recovery.reason) || changed;
          changed = true;
          candidate = this.requireCandidate(candidate.id);
        } else if (recovery?.kind === "archive") {
          record = archiveLearnedProtocol({
            slug: candidate.id,
            expectedActiveVersionId: record.activeVersionId,
            reason: recovery.reason,
            cause: recovery.cause,
            timestamp: now,
          });
          changed = this.projectState(candidate.id, record, now, recovery.reason) || changed;
          changed = true;
          continue;
        }
      }
      if (record.state === "draft" && ["approved", "active"].includes(candidate.state)) {
        record = activateLearnedProtocol({
          slug: candidate.id,
          versionId: this.newestVersion(record).id,
          expectedActiveVersionId: record.activeVersionId,
          reason: "Resumed approved activation",
          timestamp: now,
        });
        changed = true;
      }
      changed = this.projectState(candidate.id, record, now, "Recovered cross-store state") || changed;
      if (
        isReviewedProcedureCandidate(candidate)
        && record.state === "draft" && candidate.state === "candidate" && hasIndependentReviewedEvidence(candidate)
        && this.hasToolEvidence(record, this.newestVersion(record).id)
      ) {
        record = activateLearnedProtocol({
          slug: candidate.id,
          versionId: this.newestVersion(record).id,
          expectedActiveVersionId: record.activeVersionId,
          reason: "Activated on independent evidence",
          timestamp: now,
        });
        changed = this.projectState(candidate.id, record, now, "Activated on independent evidence") || changed;
        signals.push(formatLearningCandidateNudge(this.requireCandidate(candidate.id), "autonomous"));
        changed = true;
      }
    }
    return { signals, changed };
  }

  private candidate(id: string): LearnedCandidate | undefined {
    return this.learner.getCandidates().find((entry) => entry.id === id);
  }

  private requireCandidate(id: string): LearnedCandidate {
    const candidate = this.candidate(id);
    if (!candidate) throw new Error(`Unknown learned candidate: ${id}`);
    return candidate;
  }

  private recordFor(id: string): LearnedProtocolRecord | null {
    return hasLearnedProtocol(id) ? loadLearnedProtocol(id) : null;
  }

  private requireRecord(id: string): LearnedProtocolRecord {
    const record = this.recordFor(id);
    if (!record) throw new Error(`Learned candidate has no protocol draft: ${id}`);
    return record;
  }

  private newestVersion(record: LearnedProtocolRecord): LearnedProtocolVersion {
    const version = record.versions.at(-1);
    if (!version) throw new Error(`Learned protocol has no versions: ${record.slug}`);
    return version;
  }

  private projectState(
    id: string,
    record: LearnedProtocolRecord,
    now: number,
    reason: string,
  ): boolean {
    const target = record.state === "active" ? "active" : record.state === "archived" ? "archived" : "candidate";
    const rollback = record.activationHistory?.at(-1);
    const pendingRollback = target === "active" && rollback?.kind === "rollback" ? rollback : undefined;
    const projectionReason = pendingRollback?.reason === "Rolled back by user" ? "Rollback reconciled"
      : pendingRollback?.reason ?? reason;
    try {
      return this.learner.projectCandidateState(id, target, projectionReason, now, pendingRollback && {
        reason: pendingRollback.reason,
        timestamp: pendingRollback.timestamp,
      });
    }
    catch (error) {
      if (error instanceof LearningPersistenceUnavailableError) return false;
      throw error;
    }
  }

  private safetyRecovery(record: LearnedProtocolRecord) {
    const activeId = record.activeVersionId;
    if (!activeId) return null;
    const activation = [...(record.activationHistory ?? [])].reverse()
      .find((entry) => entry.versionId === activeId && entry.kind !== "archive");
    const activeVersion = record.versions.find((version) => version.id === activeId);
    if (!activeVersion) throw new Error(`Active learned protocol version is missing: ${record.slug}`);
    const boundary = activation?.timestamp ?? Date.parse(activeVersion.createdAt);
    if (!Number.isFinite(boundary) || boundary <= 0) throw new Error(`Invalid learned protocol activation boundary: ${record.slug}`);
    const outcomes = listCommittedLearnedOutcomes(record.slug, activeId)
      .filter((receipt) => receipt.timestamp >= boundary);
    const priorMetrics = new Map(record.versions
      .filter((version) => version.id !== activeId)
      .map((version) => [version.id, getVersionEffectiveness(record.slug, version.id)]));
    return selectSafetyRecovery(record, outcomes, priorMetrics);
  }

  /** A learned version confines the op that loads it to its recorded tools, so
   *  a reviewed version with none recorded would block every call. */
  private hasToolEvidence(record: LearnedProtocolRecord, versionId: string): boolean {
    const tools = record.versions.find((version) => version.id === versionId)?.metadata.allowedTools;
    return Array.isArray(tools) && tools.length > 0;
  }

}

const learningService = new CrossSessionLearningService();
export default learningService;
