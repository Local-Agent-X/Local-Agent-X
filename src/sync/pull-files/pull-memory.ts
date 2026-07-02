import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../../logger.js";
import { unionMerge } from "../mirror.js";
import { writeMemorySafely, MemoryWriteBlocked } from "../../memory/write-safely.js";

const logger = createLogger("sync.pull-files.memory");

export function pullMemoryDir(dataDir: string, syncDir: string): void {
  const syncMemDir = join(syncDir, "memory");
  const memDir = join(dataDir, "memory");
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  const remoteMemFiles = new Set<string>();
  if (existsSync(syncMemDir)) {
    // Daily chat archives (YYYY-MM-DD.md) are auto-generated transcripts
    // of the user's own conversations — already inside the trust boundary
    // when they were created. Skip taint checks on them or the filter
    // false-positives on the agent's own defensive responses (where the
    // agent quoted `<system>` tags or `<<<EXTERNAL_UNTRUSTED_CONTENT>>>`
    // markers from an injection attempt it caught). User-curated notes
    // with any other filename still get checked.
    const isDailyChatArchive = (name: string): boolean => /^\d{4}-\d{2}-\d{2}\.md$/.test(name);

    // Retired memory files that must not be pulled back — pairs with the
    // SYNC_SKIP_MEMORY_FILES set in push-files.ts. MIND.md was replaced by
    // the indexed Facts DB; pulling it back would resurrect old content
    // (the local→remote union-merge stripping doesn't help if a stale
    // remote still has the file).
    const SYNC_SKIP_MEMORY_FILES = new Set(["MIND.md"]);

    // Provenance: the sync repo is the user's OWN private repo across their own
    // devices. A curated note here is first-party — authored on a trusted device
    // and already cleared the strict 0.3 memory gate when memory_save first wrote
    // it. Re-gating at 0.3 on pull is double-jeopardy and false-positives on
    // benign prose (a name like "Dan", "run `tsc`", "act as a partner"). Pull
    // notes through at a raised threshold so only catastrophic content (≥0.9:
    // leaked EXTERNAL_UNTRUSTED markers, "ignore all previous instructions",
    // "you are now a…") is still rejected. Daily archives bypass the gate
    // entirely (below); notes keep this 0.9 backstop because they're where
    // pasted external content could legitimately land.
    const SYNC_TRUSTED_THRESHOLD = 0.9;

    for (const f of readdirSync(syncMemDir)) {
      if (!f.endsWith(".md")) continue;
      if (SYNC_SKIP_MEMORY_FILES.has(f)) continue;
      remoteMemFiles.add(f);
      const syncContent = readFileSync(join(syncMemDir, f), "utf-8");
      const localPath = join(memDir, f);
      const merged = existsSync(localPath)
        ? unionMerge(readFileSync(localPath, "utf-8"), syncContent)
        : syncContent;

      if (isDailyChatArchive(f)) {
        // Trust-boundary content — write through unchanged, preserves prior behavior.
        writeFileSync(localPath, merged, "utf-8");
        continue;
      }

      try {
        writeMemorySafely({
          content: merged,
          source: "sync",
          target: localPath,
          threshold: SYNC_TRUSTED_THRESHOLD,
          mode: "overwrite",
        });
      } catch (e) {
        if (e instanceof MemoryWriteBlocked) {
          logger.warn(`[sync] Rejected ${f}: ${e.reason}`);
          continue;
        }
        throw e;
      }
    }

    // Delete-reconciliation lives INSIDE the syncMemDir-exists guard. A
    // present remote memory dir is the manifest of what should exist; a note
    // absent from it was genuinely removed remotely (even an empty remote dir
    // means "everything was deleted") and is unlinked locally. A MISSING
    // remote memory dir is not an empty manifest — it means the remote has no
    // memory state yet (fresh/empty sync repo). Reconciling against it deleted
    // every local note before the first push ever ran, wiping notes on startup
    // when pointing sync at a new repo. Skip deletion entirely in that case.
    for (const f of readdirSync(memDir)) {
      if (f.endsWith(".md") && !remoteMemFiles.has(f)) {
        logger.info(`[sync] Deleting ${f} (removed from remote)`);
        unlinkSync(join(memDir, f));
      }
    }
  }
}

export function pullToolPolicy(dataDir: string, syncDir: string): void {
  const syncPolicy = join(syncDir, "tool-policy.json");
  if (!existsSync(syncPolicy)) return;
  try {
    const remote = JSON.parse(readFileSync(syncPolicy, "utf-8"));
    const localPath = join(dataDir, "tool-policy.json");
    if (existsSync(localPath)) {
      const local = JSON.parse(readFileSync(localPath, "utf-8"));
      const localIds = new Set((local.rules || []).map((r: any) => r.id));
      for (const rule of (remote.rules || [])) {
        if (!localIds.has(rule.id)) local.rules.push(rule);
      }
      writeFileSync(localPath, JSON.stringify(local, null, 2), "utf-8");
    } else {
      writeFileSync(localPath, readFileSync(syncPolicy, "utf-8"));
    }
  } catch { writeFileSync(join(dataDir, "tool-policy.json"), readFileSync(syncPolicy, "utf-8")); }
}
