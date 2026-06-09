/**
 * Project brief — one evolving PROJECT.md per project.
 *
 * The same evolving-markdown engine as the personality files
 * (personality.ts), namespaced per project instead of per agent. Seeded by
 * onboarding, kept current by whichever agents work the project, and injected
 * into context for the active project by buildContextBlock.
 *
 * Two things make this NOT a copy of the personality files:
 *  1. Multi-writer. Any agent on the project can update the brief, so two
 *     agents editing concurrently would lose-update each other. A per-project
 *     async mutex serializes read→merge→write so concurrent edits merge
 *     instead of clobber. Single-process (one app instance), so an in-memory
 *     lock keyed by project id is sufficient — no lockfile.
 *  2. Per-project path: <memDir>/projects/<projectId>/PROJECT.md.
 *
 * Merge reuses dedupeProfileMarkdown: an update appends the agent's change and
 * the dedupe collapses duplicate headings (latest-wins per subsection), so the
 * brief evolves toward current state rather than accreting contradictions.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { safeReadTextFile } from "./utils.js";
import { writeMemorySafely } from "./write-safely.js";
import { dedupeProfileMarkdown } from "./personality.js";
import { stripHtmlComments } from "../sanitize.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.project-brief");

const BRIEF_FILE = "PROJECT.md";

/** Default memory dir — same root the MemoryIndex uses (~/.lax/memory). */
function defaultMemDir(): string {
  return join(getLaxDir(), "memory");
}

/** Reject ids that could escape the projects dir. Real ids are
 *  `proj-<base36>-<hex>`; this just keeps a hand-passed value from
 *  traversing. */
function safeProjectId(projectId: string): string | null {
  const id = (projectId || "").trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

export function projectBriefPath(projectId: string, memDir: string = defaultMemDir()): string | null {
  const id = safeProjectId(projectId);
  if (!id) return null;
  return join(memDir, "projects", id, BRIEF_FILE);
}

/**
 * Read a project's brief. Strips HTML comments and runs the same taint check
 * the personality files get — the brief loads into agent context, so a
 * poisoned brief would be a standing injection. Returns null if missing,
 * empty, or tainted.
 */
export async function readProjectBrief(
  projectId: string,
  memDir: string = defaultMemDir(),
): Promise<string | null> {
  const path = projectBriefPath(projectId, memDir);
  if (!path || !existsSync(path)) return null;
  const content = safeReadTextFile(path);
  if (!content || !content.trim()) return null;

  const cleaned = stripHtmlComments(content).trim() || null;
  if (!cleaned) return null;

  try {
    const { checkMemoryTaint } = await import("../sanitize.js");
    const taint = checkMemoryTaint(cleaned);
    if (!taint.safe) {
      logger.warn(`project brief ${projectId} failed taint check: ${taint.reason} — skipping`);
      return null;
    }
  } catch {}

  return cleaned;
}

// Per-project serialization. chains.get(id) is the tail of the in-flight
// update chain for that project; each new update appends to it so reads and
// writes never interleave across agents. The stored chain swallows errors so
// one failed update doesn't wedge the project's lock.
const chains = new Map<string, Promise<unknown>>();

function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(projectId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(projectId, run.catch(() => {}));
  return run;
}

export interface UpdateBriefOpts {
  memDir?: string;
  /** Project title, used as the brief's top-level `#` heading the first time
   *  the doc is written. The dedupe only collapses repeated `##` sections that
   *  live under a top-level `#`, so without a root heading a re-recorded
   *  section would stack instead of replace. */
  title?: string;
}

/**
 * Merge a change into a project's brief under the per-project lock.
 *
 * `change` is markdown the agent wants reflected — a `##` section, a corrected
 * field, a new note. It's appended to the current brief and the whole thing is
 * run through dedupeProfileMarkdown, so a repeated section overwrites its prior
 * occurrence (current state wins) and net-new sections are kept. Returns the
 * merged brief.
 */
export async function updateProjectBrief(
  projectId: string,
  change: string,
  opts: UpdateBriefOpts = {},
): Promise<string> {
  const memDir = opts.memDir ?? defaultMemDir();
  const path = projectBriefPath(projectId, memDir);
  if (!path) throw new Error(`Invalid project id: ${projectId}`);
  const addition = (change || "").trim();
  if (!addition) throw new Error("project brief update requires non-empty content");

  return withProjectLock(projectId, async () => {
    const current = existsSync(path) ? (safeReadTextFile(path) || "").trim() : "";
    let combined = current ? `${current}\n\n${addition}` : addition;
    // Ensure a top-level `#` root so `##` sections group + replace under it.
    if (!/^#\s+/m.test(combined) && opts.title) {
      combined = `# ${opts.title.trim()}\n\n${combined}`;
    }
    const merged = dedupeProfileMarkdown(combined);

    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeMemorySafely({ content: merged, source: "tool", target: path, mode: "overwrite" });
    return merged;
  });
}

/** Test-only: clear the per-project lock map so fixtures don't bleed. */
export function _resetProjectBriefLocksForTest(): void {
  chains.clear();
}
