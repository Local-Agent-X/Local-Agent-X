import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore } from "../util/json-store.js";

// This routing bridge is owned by the single LAX server process. Workflow
// lifecycle integration supplies explicit transitions and cleanup, so it does
// not need cross-process locking or time-based expiry.
const STORE_VERSION = 1;
const STORE_FILENAME = "app-build-workflows.json";

export type AppBuildWorkflowPhase =
  | "planning"
  | "finalized"
  | "running"
  | "halted"
  | "complete";

export interface AppBuildWorkflow {
  kind: "app-build";
  sessionId: string;
  phase: AppBuildWorkflowPhase;
  projectDir?: string;
  opId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppBuildWorkflowQuery {
  sessionId?: string;
  phase?: AppBuildWorkflowPhase;
  projectDir?: string;
  opId?: string;
}

export interface AppBuildWorkflowStore {
  read(sessionId: string): AppBuildWorkflow | null;
  upsert(input: {
    sessionId: string;
    phase: AppBuildWorkflowPhase;
    projectDir?: string;
    opId?: string;
  }): AppBuildWorkflow;
  update(
    sessionId: string,
    patch: Partial<Pick<AppBuildWorkflow, "phase" | "projectDir" | "opId">>,
  ): AppBuildWorkflow | null;
  clear(sessionId: string): boolean;
  query(filters?: AppBuildWorkflowQuery): AppBuildWorkflow[];
}

type WorkflowFile = {
  version: number;
  workflows: AppBuildWorkflow[];
};

const PHASES = new Set<AppBuildWorkflowPhase>([
  "planning",
  "finalized",
  "running",
  "halted",
  "complete",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function requirePhase(value: unknown): AppBuildWorkflowPhase {
  if (!PHASES.has(value as AppBuildWorkflowPhase)) {
    throw new Error(`Invalid app-build workflow phase: ${String(value)}`);
  }
  return value as AppBuildWorkflowPhase;
}

function requireOptionalString(field: "projectDir" | "opId", value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`App-build workflow ${field} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeAppBuildProjectDir(projectDir: string): string {
  const normalized = projectDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const windowsPath = /^[a-z]:\//i.test(normalized) || normalized.startsWith("//");
  return windowsPath ? normalized.toLowerCase() : normalized;
}

function isWorkflow(value: unknown): value is AppBuildWorkflow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<AppBuildWorkflow>;
  return record.kind === "app-build"
    && isNonEmptyString(record.sessionId)
    && PHASES.has(record.phase as AppBuildWorkflowPhase)
    && isTimestamp(record.createdAt)
    && isTimestamp(record.updatedAt)
    && (record.projectDir === undefined || isNonEmptyString(record.projectDir))
    && (record.opId === undefined || isNonEmptyString(record.opId));
}

function sanitizeFile(parsed: unknown): WorkflowFile {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { version: STORE_VERSION, workflows: [] };
  }
  const file = parsed as Partial<WorkflowFile>;
  if (file.version !== STORE_VERSION || !Array.isArray(file.workflows)) {
    return { version: STORE_VERSION, workflows: [] };
  }
  return {
    version: STORE_VERSION,
    workflows: file.workflows.filter(isWorkflow),
  };
}

export function appBuildWorkflowStorePath(): string {
  return join(getLaxDir(), STORE_FILENAME);
}

export function createAppBuildWorkflowStore(
  filePath = appBuildWorkflowStorePath(),
): AppBuildWorkflowStore {
  const store = createJsonStore<WorkflowFile>(filePath, {
    defaults: () => ({ version: STORE_VERSION, workflows: [] }),
    upgrade: sanitizeFile,
  });

  function query(filters: AppBuildWorkflowQuery = {}): AppBuildWorkflow[] {
    const projectDir = filters.projectDir === undefined
      ? undefined
      : normalizeAppBuildProjectDir(filters.projectDir);
    return store.load().workflows.filter(workflow =>
      (filters.sessionId === undefined || workflow.sessionId === filters.sessionId)
      && (filters.phase === undefined || workflow.phase === filters.phase)
      && (projectDir === undefined || (
        workflow.projectDir !== undefined
        && normalizeAppBuildProjectDir(workflow.projectDir) === projectDir
      ))
      && (filters.opId === undefined || workflow.opId === filters.opId));
  }

  function read(sessionId: string): AppBuildWorkflow | null {
    return query({ sessionId })[0] ?? null;
  }

  function upsert(input: {
    sessionId: string;
    phase: AppBuildWorkflowPhase;
    projectDir?: string;
    opId?: string;
  }): AppBuildWorkflow {
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new Error("App-build workflow requires a sessionId");
    const phase = requirePhase(input.phase);
    const projectDir = input.projectDir === undefined
      ? undefined
      : requireOptionalString("projectDir", input.projectDir);
    const opId = input.opId === undefined
      ? undefined
      : requireOptionalString("opId", input.opId);
    const now = new Date().toISOString();
    let saved!: AppBuildWorkflow;
    store.mutate(file => {
      const existing = file.workflows.find(workflow => workflow.sessionId === sessionId);
      saved = {
        kind: "app-build",
        sessionId,
        phase,
        ...(existing?.projectDir ? { projectDir: existing.projectDir } : {}),
        ...(existing?.opId ? { opId: existing.opId } : {}),
        ...(projectDir ? { projectDir } : {}),
        ...(opId ? { opId } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      file.workflows = file.workflows.filter(workflow => workflow.sessionId !== sessionId);
      file.workflows.push(saved);
    });
    return saved;
  }

  function update(
    sessionId: string,
    patch: Partial<Pick<AppBuildWorkflow, "phase" | "projectDir" | "opId">>,
  ): AppBuildWorkflow | null {
    const validated: typeof patch = {};
    if (Object.hasOwn(patch, "phase")) validated.phase = requirePhase(patch.phase);
    if (Object.hasOwn(patch, "projectDir")) {
      validated.projectDir = requireOptionalString("projectDir", patch.projectDir);
    }
    if (Object.hasOwn(patch, "opId")) {
      validated.opId = requireOptionalString("opId", patch.opId);
    }
    if (!store.load().workflows.some(workflow => workflow.sessionId === sessionId)) {
      return null;
    }
    let updated: AppBuildWorkflow | null = null;
    store.mutate(file => {
      const index = file.workflows.findIndex(workflow => workflow.sessionId === sessionId);
      if (index < 0) return;
      updated = {
        ...file.workflows[index],
        ...validated,
        updatedAt: new Date().toISOString(),
      };
      file.workflows[index] = updated;
    });
    return updated;
  }

  function clear(sessionId: string): boolean {
    let removed = false;
    store.mutate(file => {
      const remaining = file.workflows.filter(workflow => workflow.sessionId !== sessionId);
      removed = remaining.length !== file.workflows.length;
      file.workflows = remaining;
    });
    return removed;
  }

  return { read, upsert, update, clear, query };
}

export function readAppBuildWorkflow(sessionId: string): AppBuildWorkflow | null {
  return createAppBuildWorkflowStore().read(sessionId);
}

export function queryAppBuildWorkflows(filters?: AppBuildWorkflowQuery): AppBuildWorkflow[] {
  return createAppBuildWorkflowStore().query(filters);
}

export function upsertAppBuildWorkflow(
  input: Parameters<AppBuildWorkflowStore["upsert"]>[0],
): AppBuildWorkflow {
  return createAppBuildWorkflowStore().upsert(input);
}

export function updateAppBuildWorkflow(
  sessionId: string,
  patch: Parameters<AppBuildWorkflowStore["update"]>[1],
): AppBuildWorkflow | null {
  return createAppBuildWorkflowStore().update(sessionId, patch);
}

export function clearAppBuildWorkflow(sessionId: string): boolean {
  return createAppBuildWorkflowStore().clear(sessionId);
}
