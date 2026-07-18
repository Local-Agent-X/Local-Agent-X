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
import { CrossSessionLearner } from "./learner.js";
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
    return this.learner.getCandidates().map((candidate) => this.summary(candidate, this.recordFor(candidate.id)));
  }

  detail(id: string): LearningDetail | null {
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
      const active = activateLearnedProtocol({ slug: id, versionId, expectedActiveVersionId: input.expectedActiveVersionId });
      this.healState(candidate, active, now, "Activated by user");
    } else if (input.action === "archive") {
      const archived = archiveLearnedProtocol({ slug: id, expectedActiveVersionId: input.expectedActiveVersionId });
      this.healState(candidate, archived, now, "Archived by user");
    } else if (input.action === "restore") {
      const active = restoreLearnedProtocol({ slug: id, expectedActiveVersionId: input.expectedActiveVersionId });
      this.healState(candidate, active, now, "Restored by user");
    } else {
      const active = rollbackLearnedProtocol({
        slug: id,
        versionId: input.versionId,
        expectedActiveVersionId: input.expectedActiveVersionId,
      });
      this.recordRollback(id, now);
      this.healState(this.requireCandidate(id), active, now, "Rollback reconciled");
    }
    return this.detail(id)!;
  }

  reconcile(mode: "assisted" | "autonomous", now = Date.now()): LearningReconcileResult {
    let changed = false;
    const signals: ModuleSignal[] = [];
    const signaledIds = new Set<string>();

    for (let candidate of this.learner.getCandidates()) {
      let record = this.recordFor(candidate.id);
      if (!record) continue;
      if (record.state === "draft" && ["approved", "active"].includes(candidate.state)) {
        record = activateLearnedProtocol({
          slug: candidate.id,
          versionId: this.newestVersion(record).id,
          expectedActiveVersionId: record.activeVersionId,
        });
        changed = this.healState(candidate, record, now, "Resumed approved activation") || changed;
        candidate = this.requireCandidate(candidate.id);
      }
      changed = this.healState(candidate, record, now, "Recovered cross-store state") || changed;
      if (mode === "autonomous" && record.state === "draft") {
        const active = activateLearnedProtocol({
          slug: candidate.id,
          versionId: this.newestVersion(record).id,
          expectedActiveVersionId: record.activeVersionId,
        });
        changed = this.healState(this.requireCandidate(candidate.id), active, now, "Activated automatically") || changed;
        signals.push(formatLearningCandidateNudge(this.requireCandidate(candidate.id), "autonomous"));
        signaledIds.add(candidate.id);
        changed = true;
      }
    }

    const candidate = this.learner.nextLearningCandidate(now);
    if (!candidate) return { signals, changed };
    const drafted = this.learner.draftCandidate(candidate.id);
    changed = drafted.created || changed;
    if (mode === "autonomous") {
      const before = loadLearnedProtocol(drafted.slug);
      if (before.activeVersionId !== drafted.version.id) {
        const active = activateLearnedProtocol({
          slug: drafted.slug,
          versionId: drafted.version.id,
          expectedActiveVersionId: before.activeVersionId,
        });
        changed = this.healState(this.requireCandidate(candidate.id), active, now, "Activated automatically") || changed;
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
    const effectiveState = record?.state === "active" ? "active" : record?.state === "archived" ? "archived" : candidate.state;
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

  private healState(candidate: LearnedCandidate, record: LearnedProtocolRecord, now: number, reason: string): boolean {
    const target = record.state === "active" ? "active" : record.state === "archived" ? "archived" : "candidate";
    if (candidate.state === target) return false;
    for (const state of this.path(candidate.state, target)) {
      this.learner.setCandidateState(candidate.id, state, reason, now);
    }
    return true;
  }

  private path(from: LearnedCandidateState, to: "candidate" | "active" | "archived"): LearnedCandidateState[] {
    if (to === "active") {
      if (from === "candidate") return ["approved", "active"];
      if (from === "approved") return ["active"];
      if (from === "active") return [];
      return ["candidate", "approved", "active"];
    }
    if (to === "archived") return from === "archived" ? [] : ["archived"];
    if (from === "active") return ["rolled-back", "candidate"];
    if (from === "approved") throw new Error("Approved learned workflow requires activation recovery");
    return from === "candidate" ? [] : ["candidate"];
  }

  private recordRollback(id: string, now: number): void {
    const candidate = this.requireCandidate(id);
    if (candidate.state === "active") {
      this.learner.setCandidateState(id, "rolled-back", "Rolled back by user", now);
      this.learner.setCandidateState(id, "candidate", "Rollback retained active workflow", now);
    }
  }
}

const learningService = new CrossSessionLearningService();
export default learningService;
