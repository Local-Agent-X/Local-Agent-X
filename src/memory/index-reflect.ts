import type Database from "better-sqlite3";
import type { RetainedFact } from "./types.js";
import { slugify } from "./utils.js";
import { recallByTime, recallOpinions } from "./index-facts.js";
import { updateEntityPage } from "./index-forget.js";

export async function reflect(
  db: InstanceType<typeof Database>,
  entitiesDir: string,
  setDirty: () => void,
  reindexEntity: (slug: string) => void,
  sinceDays = 7
): Promise<{
  entitiesUpdated: string[];
  opinionsUpdated: number;
}> {
  const { entityFactMap, recentFacts } = db.transaction(() => {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const facts = recallByTime(db, since);
    const map = new Map<string, RetainedFact[]>();
    for (const fact of facts) {
      for (const entity of fact.entities) {
        const slug = slugify(entity);
        if (!map.has(slug)) map.set(slug, []);
        map.get(slug)!.push(fact);
      }
    }
    return { entityFactMap: map, recentFacts: facts };
  })();

  const entitiesUpdated: string[] = [];
  for (const [slug, facts] of entityFactMap) {
    updateEntityPage(db, entitiesDir, setDirty, reindexEntity, slug, facts);
    entitiesUpdated.push(slug);
  }

  let opinionsUpdated = 0;
  const opinions = recallOpinions(db);
  for (const opinion of opinions) {
    const updated = updateOpinionConfidence(db, opinion, recentFacts);
    if (updated) opinionsUpdated++;
  }

  return { entitiesUpdated, opinionsUpdated };
}

/** A fact's evidence list with each source once, in the order first seen. */
export function uniqueEvidence(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/** The same for a stored `evidence_for` column; the text unchanged when it
 *  holds no repeat or is not a list of sources. */
export function uniqueEvidenceJson(json: string): string {
  let list: unknown;
  try { list = JSON.parse(json); } catch { return json; } // not JSON: left for whoever wrote it
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) return json;
  const unique = uniqueEvidence(list);
  return unique.length === list.length ? json : JSON.stringify(unique);
}

function updateOpinionConfidence(
  db: InstanceType<typeof Database>,
  opinion: RetainedFact,
  recentFacts: RetainedFact[]
): boolean {
  const opinionEntities = new Set(opinion.entities.map(slugify));
  const related = recentFacts.filter(
    (f) =>
      f.id !== opinion.id &&
      f.entities.some((e) => opinionEntities.has(slugify(e)))
  );

  if (related.length === 0) return false;

  // Each run looks back over the same days, so most of what it finds is
  // already on the list. Only a source not there yet is news; with none, the
  // row is left alone (a re-added list grew one fact to 10,646 entries, 23 of
  // them distinct, and the facts sync file to 40 MB).
  const newEvidenceFor = uniqueEvidence([
    ...opinion.evidenceFor,
    ...related
      .filter((f) => f.kind !== "opinion")
      .map((f) => `${f.sourceFile}#L${f.sourceLine}`),
  ]);
  const unchanged = newEvidenceFor.length === opinion.evidenceFor.length
    && newEvidenceFor.every((s, i) => s === opinion.evidenceFor[i]);
  if (unchanged) return false;

  db
    .prepare(
      "UPDATE facts SET evidence_for = ?, last_updated = ? WHERE id = ?"
    )
    .run(JSON.stringify(newEvidenceFor), Date.now(), opinion.id);

  return true;
}
