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
  isSafeRefinementVersion,
  isStrongerRefinement,
  selectSafetyRecovery,
} from "../../protocols/learned-refinement.js";
import { CrossSessionLearner, LearningPersistenceUnavailableError } from "./learner.js";
import type { LearnedCandidate, LearnedCandidateState } from "./types.js";

export interface LearningSummary {
  id: string;
  name: string;
  state: LearnedCandidateState;
  confidence: number;
  updatedAt: string;
  activeVersionId: string | null;
  versionCount: number;
}

export interface LearningVersionView {
  id: string;
  name: string;
  createdAt: string;
  active: boolean;
  metadata: Record<string, unknown>;
}

export interface LearningDetail extends LearningSummary {
  evidence: LearnedCandidate["evidence"];
  history: LearnedCandidate["transitions"];
  versions: LearningVersionView[];
}

export type LearningAction =
  | { action: "activate"; versionId?: string; expectedActiveVersionId: string | null }
  | { action: "reject" }
  | { action: "archive"; expectedActiveVersionId: string | null }
  | { action: "restore"; expectedActiveVersionId: string | null }
  | { action: "rollback"; versionId: string; expectedActiveVersionId: string | null };

export interface LearningReconcileResult {
  signals: ModuleSignal[];
  changed: boolean;
}

export class CrossSessionLearningService {
  constructor(private readonly learner = CrossSessionLearner.getInstance()) {}

  list(): LearningSummary[] {
    this.learner.refresh();
    return this.learner.getCandidates().map((candidate) => this.summary(candidate, this.recordFor(candidate.id)));
  }

  detail(id: string): LearningDetail | null {
    this.learner.refresh();
    const candidate = this.candidate(id);
    if (!candidate) return null;
    const record = this.recordFor(id);
    return {
      ...this.summary(candidate, record),
      evidence: structuredClone(candidate.evidence),
      history: structuredClone(candidate.transitions),
      versions: record ? record.versions.map((version, index) => this.versionView(version, index, record)) : [],
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

  reconcile(mode: "assisted" | "autonomous", now = Date.now()): LearningReconcileResult {
    this.learner.refresh();
    let changed = false;
    const signals: ModuleSignal[] = [];
    const signaledIds = new Set<string>();
    const safetyRecoveredIds = new Set<string>();

    for (let candidate of this.learner.getCandidates()) {
      let record = this.recordFor(candidate.id);
      if (["rejected", "rolled-back"].includes(candidate.state) && record?.state !== "active") continue;
      if (!record) {
        const rebuilt = this.learner.draftCandidate(candidate.id);
        record = loadLearnedProtocol(rebuilt.slug);
        changed = rebuilt.created || changed;
        if (candidate.state === "archived") {
          record = activateLearnedProtocol({
            slug: candidate.id,
            versionId: rebuilt.version.id,
            expectedActiveVersionId: null,
            reason: "Reconstructed archived learned workflow",
            timestamp: now,
          });
          record = archiveLearnedProtocol({
            slug: candidate.id,
            expectedActiveVersionId: record.activeVersionId,
            reason: "Preserved archived learned workflow",
            timestamp: now,
          });
        }
      }
      if (record.state === "active") {
        const recovery = this.safetyRecovery(record);
        if (recovery?.kind === "rollback") {
          record = rollbackLearnedProtocol({
            slug: candidate.id,
            versionId: recovery.targetVersionId,
            expectedActiveVersionId: record.activeVersionId,
            reason: recovery.reason,
            timestamp: now,
          });
          changed = this.projectState(candidate.id, record, now, recovery.reason) || changed;
          changed = true;
          safetyRecoveredIds.add(candidate.id);
          candidate = this.requireCandidate(candidate.id);
        } else if (recovery?.kind === "archive") {
          record = archiveLearnedProtocol({
            slug: candidate.id,
            expectedActiveVersionId: record.activeVersionId,
            reason: recovery.reason,
            timestamp: now,
          });
          changed = this.projectState(candidate.id, record, now, recovery.reason) || changed;
          changed = true;
          safetyRecoveredIds.add(candidate.id);
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
      if (mode === "autonomous" && record.state === "active" && !safetyRecoveredIds.has(candidate.id)) {
        const target = this.newestVersion(record);
        const activeVersionId = record.activeVersionId;
        const current = record.versions.find((version) => version.id === activeVersionId);
        if (
          current
          && target.id !== current.id
          && isSafeRefinementVersion(current, target, candidate.id)
          && !this.wasSafetyRejected(record, target.id)
        ) {
          record = activateLearnedProtocol({
            slug: candidate.id,
            versionId: target.id,
            expectedActiveVersionId: record.activeVersionId,
            reason: "Activated stronger refinement automatically",
            timestamp: now,
          });
          changed = this.projectState(candidate.id, record, now, "Activated automatically") || changed;
          signals.push(formatLearningCandidateNudge(this.requireCandidate(candidate.id), "autonomous"));
          signaledIds.add(candidate.id);
          changed = true;
        }
      }
      if (mode === "autonomous" && record.state === "draft") {
        const active = activateLearnedProtocol({
          slug: candidate.id,
          versionId: this.newestVersion(record).id,
          expectedActiveVersionId: record.activeVersionId,
          reason: "Activated automatically",
          timestamp: now,
        });
        changed = this.projectState(candidate.id, active, now, "Activated automatically") || changed;
        signals.push(formatLearningCandidateNudge(this.requireCandidate(candidate.id), "autonomous"));
        signaledIds.add(candidate.id);
        changed = true;
      }
    }

    const opportunity = this.learner.nextLearningOpportunity(now);
    if (!opportunity) return { signals, changed };
    const candidate = opportunity.candidate;
    if (safetyRecoveredIds.has(candidate.id)) return { signals, changed };
    const existing = this.recordFor(candidate.id);
    if (existing && existing.versions.length > 0 && !isStrongerRefinement(opportunity.draftCandidate, this.newestVersion(existing))) {
      return { signals, changed };
    }
    const drafted = this.learner.draftCandidate(candidate.id, opportunity.draftCandidate);
    changed = drafted.created || changed;
    if (mode === "autonomous") {
      const before = loadLearnedProtocol(drafted.slug);
      if (before.activeVersionId !== drafted.version.id && !this.wasSafetyRejected(before, drafted.version.id)) {
        const active = activateLearnedProtocol({
          slug: drafted.slug,
          versionId: drafted.version.id,
          expectedActiveVersionId: before.activeVersionId,
          reason: before.activeVersionId ? "Activated stronger refinement automatically" : "Activated automatically",
          timestamp: now,
        });
        changed = this.projectState(candidate.id, active, now, "Activated automatically") || changed;
      }
    }
    if (!signaledIds.has(candidate.id)) {
      signals.push(formatLearningCandidateNudge(this.requireCandidate(candidate.id), mode));
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

  private summary(candidate: LearnedCandidate, record: LearnedProtocolRecord | null): LearningSummary {
    const latest = record?.versions.at(-1)?.createdAt;
    const effectiveState = record?.state === "active" ? "active"
      : record?.state === "archived" ? "archived"
      : record && !["rejected", "rolled-back"].includes(candidate.state) ? "candidate"
      : candidate.state;
    return {
      id: candidate.id,
      name: candidate.suggestion.name,
      state: effectiveState,
      confidence: candidate.confidence,
      updatedAt: latest && Date.parse(latest) > candidate.updatedAt ? latest : new Date(candidate.updatedAt).toISOString(),
      activeVersionId: record?.activeVersionId ?? null,
      versionCount: record?.versions.length ?? 0,
    };
  }

  private versionView(version: LearnedProtocolVersion, index: number, record: LearnedProtocolRecord): LearningVersionView {
    return {
      id: version.id,
      name: `Version ${index + 1}`,
      createdAt: version.createdAt,
      active: version.id === record.activeVersionId,
      metadata: structuredClone(version.metadata),
    };
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

  private wasSafetyRejected(record: LearnedProtocolRecord, versionId: string): boolean {
    return (record.activationHistory ?? []).some((entry) =>
      entry.kind === "rollback"
      && entry.previousVersionId === versionId
      && entry.reason.startsWith("Safety rollback:"));
  }

}

const learningService = new CrossSessionLearningService();
export default learningService;
