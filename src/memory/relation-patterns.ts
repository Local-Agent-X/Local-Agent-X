import { slugify } from "./utils.js";

/**
 * Canonical relationship-verb vocabulary for entity extraction. This is the
 * single source both the graph writer (index-relations) and the skeleton
 * compressor (cognitive/compression) draw from — neither keeps its own list.
 */
export const RELATION_VERBS =
  "decided|decides|suggested|suggests|introduced|introduces|recommended|recommends|told|asked|wants|wanted|likes|loves|prefers|preferred|owns|owned|uses|used|built|builds|created|creates|shipped|ships|launched|launches|joined|joins|left|leaves|met|meets|works|worked|manages|managed|reports|reported|scheduled|schedules|planned|plans|bought|buys|sold|sells|sent|sends|received|receives|served|serves|retired|retires|lives|lived|moved|moves|started|starts|stopped|stops|finished|finishes|completed|completes|belongs|competes|competed|depends|depended";

const predicateRe = new RegExp(
  `\\b([A-Z][a-zA-Z]+|my|our|the|W)?\\s*(${RELATION_VERBS})\\s+(?:(?:about|with|from|into|onto|upon|for|the|an|at|in|on|to|me|us|a)\\s+)?([a-zA-Z][a-zA-Z0-9\\s-]{2,40})`,
  "gi"
);
const trailingNoiseRe = /\s+(and|or|but|when|while|after|before|last|next|right|just|then|so|because|since|until|over|during|yesterday|today|tomorrow|ago)\b.*$/i;
const leadingFillerRe = /^(the|a|an|my|our|their|his|her|its|this|that|these|those)\s+/i;
const subjectFillers = new Set([
  "my", "our", "the", "w", "a", "an", "this", "that", "these", "those",
  "with", "about", "from", "into", "onto", "upon", "for", "at", "in", "on", "to",
  "me", "us", "you", "him", "her", "it", "them", "they", "we", "i",
  "after", "before", "when", "while", "then", "and", "or", "but", "so",
]);

export interface RelationTriple {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * Pull subject-predicate-object triples from free text. `entities` supplies the
 * subject fallback when a clause leads with a pronoun/filler ("He uses X" →
 * subject defaults to the first known entity). Pure — no persistence.
 */
export function extractRelationTriples(text: string, entities: string[]): RelationTriple[] {
  if (!text) return [];
  const triples: RelationTriple[] = [];
  const seen = new Set<string>();
  predicateRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = predicateRe.exec(text)) !== null) {
    const subjectRaw = (match[1] || "").toLowerCase();
    const predicate = match[2].toLowerCase();
    let objectRaw = match[3].trim();
    objectRaw = objectRaw.replace(trailingNoiseRe, "").trim();
    objectRaw = objectRaw.replace(leadingFillerRe, "").trim();
    const object = objectRaw.split(/\s+/).slice(0, 4).join(" ");

    let subject = subjectRaw;
    if (!subject || subjectFillers.has(subject)) {
      subject = entities[0] || "";
    }
    if (!subject) continue;

    if (object.length < 3) continue;
    if (/^(the|a|an|me|us|you|him|her|it|them)$/i.test(object)) continue;
    if (slugify(object) === slugify(subject)) continue;
    if (object.toLowerCase() === predicate) continue;

    const key = `${subject}|${predicate}|${object}`;
    if (seen.has(key)) continue;
    seen.add(key);

    triples.push({ subject, predicate, object });
  }
  return triples;
}
