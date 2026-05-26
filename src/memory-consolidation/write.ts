// Disk writer for consolidation. One export:
//   - updateAllEntityPages: writes per-entity markdown files under bank/entities/
//
// The old promoteToLongTerm wrote facts to MIND.md. MIND.md is retired —
// facts now live in the indexed Facts DB (src/memory/index-facts.ts), and
// agent-driven writes go through `remember`/`update_fact`/`forget`. The
// dream-consolidation cycle no longer "promotes" because there's no
// separate long-term store to promote into; the Facts DB IS that store.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITIES_DIR, type FactEntry } from "./types.js";
import { todayDateStr } from "./utils.js";

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

