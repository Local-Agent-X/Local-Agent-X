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

  const newEvidenceFor = [
    ...opinion.evidenceFor,
    ...related
      .filter((f) => f.kind !== "opinion")
      .map((f) => `${f.sourceFile}#L${f.sourceLine}`),
  ];

  db
    .prepare(
      "UPDATE facts SET evidence_for = ?, last_updated = ? WHERE id = ?"
    )
    .run(JSON.stringify(newEvidenceFor), Date.now(), opinion.id);

  return true;
}
