// Disk writers + the universal-index write-through. Three exports:
//   - promoteToLongTerm: appends new candidates to MIND.md
//   - updateAllEntityPages: writes per-entity markdown files under bank/entities/
//   - scrubMindFile: one-shot cleanup that removes chat-transcript lines
//     that leaked into MIND.md in older builds (idempotent — a clean
//     file passes through untouched)
//
// All writers fire a best-effort reindex into the universal-index after
// the file changes. Failure to reindex never blocks the write.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITIES_DIR, MIND_PATH, type FactEntry } from "./types.js";
import { ensureDirs, todayDateStr } from "./utils.js";

export function promoteToLongTerm(facts: string[]): void {
  if (facts.length === 0) return;
  ensureDirs();

  let mindContent = "";
  if (existsSync(MIND_PATH)) {
    mindContent = readFileSync(MIND_PATH, "utf-8");
  }

  const newLines: string[] = [];
  for (const fact of facts) {
    const trimmed = fact.trim();
    // Last-line-of-defense: refuse to write chat-transcript snippets into
    // strategic memory even if they slipped past every earlier filter.
    if (/^\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]/i.test(trimmed)) continue;
    if (/^(User|Agent):\s/i.test(trimmed)) continue;
    if (/^User (?:said|asked|wrote|shared|sent|told|replied)/i.test(trimmed)) continue;
    // Skip if already present
    if (mindContent.includes(trimmed)) continue;
    newLines.push(`- ${trimmed}`);
  }

  if (newLines.length === 0) return;

  const section = `\n\n## Consolidated (${todayDateStr()})\n${newLines.join("\n")}\n`;
  writeFileSync(MIND_PATH, mindContent + section, "utf-8");

  // Write-through: MIND.md just changed, push the new chunks into search.
  // Fire-and-forget so a missing universal-index never blocks consolidation.
  import("../memory/universal-index.js")
    .then(({ getUniversalIndex }) => getUniversalIndex()?.indexMindFile())
    .catch(() => {});
}

export function updateAllEntityPages(grouped: Map<string, FactEntry[]>): number {
  let updated = 0;
  const touchedSlugs: string[] = [];
  for (const [slug, facts] of grouped) {
    if (facts.length === 0) continue;
    const entityPath = join(ENTITIES_DIR, `${slug}.md`);

    let existing = "";
    if (existsSync(entityPath)) {
      existing = readFileSync(entityPath, "utf-8");
    }

    const displayName = facts[0].entity || slug;
    const newFacts = facts.filter((f) => !existing.includes(f.content));
    if (newFacts.length === 0) continue;

    const additions = newFacts
      .map((f) => `- ${f.content} (c=${f.confidence.toFixed(2)})`)
      .join("\n");

    if (existing) {
      appendFileSync(
        entityPath,
        `\n\n### Consolidated ${todayDateStr()}\n${additions}\n`,
        "utf-8"
      );
    } else {
      const header = `# ${displayName}\n\n*Created: ${todayDateStr()}*\n\n### Facts\n${additions}\n`;
      writeFileSync(entityPath, header, "utf-8");
    }

    updated++;
    touchedSlugs.push(slug);
  }

  // Write-through reindex for every entity page that changed. Fire-and-
  // forget so consolidation never blocks on the embedding pipeline.
  if (touchedSlugs.length > 0) {
    import("../memory/universal-index.js")
      .then(({ getUniversalIndex }) => {
        const ui = getUniversalIndex();
        if (!ui) return;
        for (const s of touchedSlugs) ui.indexEntityPage(s).catch(() => {});
      })
      .catch(() => {});
  }
  return updated;
}

/**
 * One-shot scrub of MIND.md to remove chat-transcript lines that shouldn't
 * be there. Strategic Memory should hold curated facts, not raw User:/Agent:
 * turns. Idempotent — a clean file passes through untouched.
 *
 * Called on startup. The consolidator now also rejects transcript lines at
 * parse time so pollution doesn't re-accumulate.
 */
export function scrubMindFile(): { linesRemoved: number; linesKept: number } {
  if (!existsSync(MIND_PATH)) return { linesRemoved: 0, linesKept: 0 };
  const original = readFileSync(MIND_PATH, "utf-8");
  const lines = original.split(/\r?\n/);
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    // Strip chat-transcript shaped bullet entries
    if (/^\s*-\s*\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]\s+(User|Agent):/i.test(line)) { removed++; continue; }
    if (/^\s*-\s*(User|Agent):\s/i.test(line)) { removed++; continue; }
    if (/^\s*-\s*User (?:said|asked|wrote|shared|sent|told|replied)/i.test(line)) { removed++; continue; }
    kept.push(line);
  }
  if (removed === 0) return { linesRemoved: 0, linesKept: kept.length };
  // Collapse any run of 3+ blank lines down to 2
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  writeFileSync(MIND_PATH, collapsed, "utf-8");
  return { linesRemoved: removed, linesKept: kept.length };
}
