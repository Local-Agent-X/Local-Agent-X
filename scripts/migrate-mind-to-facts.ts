/**
 * One-shot migration: parse ~/.lax/memory/MIND.md, retain each entry as a
 * fact in the SQLite facts DB, then archive MIND.md. The UNIQUE constraint
 * on (kind, content, entities) handles dedup automatically — running this
 * twice is a no-op.
 *
 * Run with: node --import=tsx scripts/migrate-mind-to-facts.ts
 */

import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MemoryIndex } from "../src/memory/index-core.js";

const LAX_DATA_DIR = process.env.LAX_DATA_DIR || join(homedir(), ".lax");
const MIND_PATH = join(LAX_DATA_DIR, "memory", "MIND.md");

function splitIntoFacts(raw: string): string[] {
  // MIND.md grew organically with no consistent paragraph structure — most
  // lines are self-contained statements; some are bullets; some are
  // `**Section:**` markers followed by bullets; YAML-ish metadata blocks
  // (`name:`, `description:`, `type:`) preface some entries. Split per-line
  // and treat each "fact-shaped" line as one fact. Heading lines attach to
  // the next fact as context. **Section:** markers attach to immediately
  // following bullets.
  const lines = raw.split("\n");
  const facts: string[] = [];
  let pendingHeading: string | null = null;
  let pendingSection: string | null = null;

  const isMetadataLine = (l: string) =>
    /^(---|name:|description:|type:)\s*/.test(l);
  const isPureHeading = (l: string) => /^#{1,4}\s+\S/.test(l);
  const isBoldSectionMarker = (l: string) => /^\*\*[^*]+:\*\*\s*$/.test(l.trim());
  const isBullet = (l: string) => /^\s*[-*]\s+\S/.test(l);

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      // Blank line — drop pending section but keep pending heading
      // (since headings often span several blocks below them).
      pendingSection = null;
      continue;
    }

    if (isMetadataLine(line)) {
      // Skip YAML-ish frontmatter entirely
      continue;
    }

    if (isPureHeading(line)) {
      pendingHeading = line.replace(/^#+\s+/, "").trim();
      pendingSection = null;
      continue;
    }

    if (isBoldSectionMarker(line)) {
      pendingSection = line.replace(/\*/g, "").replace(/:$/, "").trim();
      continue;
    }

    let body = line.trim();
    if (isBullet(body)) body = body.replace(/^\s*[-*]\s+/, "").trim();

    if (body.length < 5) continue;

    const prefixParts: string[] = [];
    if (pendingHeading) prefixParts.push(pendingHeading);
    if (pendingSection) prefixParts.push(pendingSection);
    const fact = prefixParts.length > 0 ? `${prefixParts.join(" — ")}: ${body}` : body;
    facts.push(fact);
  }

  return facts;
}

async function main() {
  if (!existsSync(MIND_PATH)) {
    console.log(`No MIND.md at ${MIND_PATH} — nothing to migrate.`);
    return;
  }

  const raw = readFileSync(MIND_PATH, "utf-8");
  const sizeKb = (statSync(MIND_PATH).size / 1024).toFixed(1);
  console.log(`Source: ${MIND_PATH} (${sizeKb} KB, ${raw.split("\n").length} lines)`);

  const facts = splitIntoFacts(raw);
  console.log(`Parsed ${facts.length} candidate facts`);

  if (facts.length === 0) {
    console.log("No facts found — leaving MIND.md alone.");
    return;
  }

  const memory = new MemoryIndex(LAX_DATA_DIR);

  let inserted = 0;
  let duplicates = 0;
  let failed = 0;
  let tooShort = 0;
  const errors: Array<{ content: string; error: string }> = [];

  for (let i = 0; i < facts.length; i++) {
    const content = facts[i];
    if (content.length < 3) { tooShort++; continue; }
    const result = memory.rememberFact(content, { sourceFile: "MIND.md-migration" });
    if (result.ok) {
      inserted++;
    } else if (result.error?.includes("already exists") || result.error?.includes("duplicate")) {
      duplicates++;
    } else {
      failed++;
      if (errors.length < 10) errors.push({ content: content.slice(0, 80), error: result.error ?? "?" });
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${facts.length}: inserted=${inserted} dup=${duplicates} fail=${failed}`);
  }

  console.log("");
  console.log("─── Migration summary ───────────────────────────");
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Duplicates (skipped): ${duplicates}`);
  console.log(`  Too short: ${tooShort}`);
  console.log(`  Failed: ${failed}`);
  if (errors.length > 0) {
    console.log("");
    console.log("  Sample failures:");
    for (const e of errors) console.log(`    - ${e.content}... → ${e.error}`);
  }

  if (inserted === 0) {
    console.log("");
    console.log("No new facts inserted. Leaving MIND.md alone.");
    memory.close();
    return;
  }

  const stamp = new Date().toISOString().split("T")[0];
  const archivePath = `${MIND_PATH}.archive-${stamp}`;
  renameSync(MIND_PATH, archivePath);
  writeFileSync(
    MIND_PATH,
    `# MIND.md\n\nFacts moved to the indexed Facts DB on ${stamp}. ` +
      `Use \`remember\` / \`update_fact\` / \`forget\` tools instead of appending here. ` +
      `Archive of prior content: ${archivePath}\n`,
    "utf-8"
  );
  console.log("");
  console.log(`Archived original MIND.md → ${archivePath}`);
  console.log(`Replaced MIND.md with stub pointing at the Facts DB.`);

  memory.close();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
