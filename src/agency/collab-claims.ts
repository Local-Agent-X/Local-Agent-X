/**
 * The claims record of a collab (collab.ts): reading the lines each member
 * writes for the app, and what state each claim is in.
 *
 * Members write plain lines, one per claim, in three sections:
 *
 *   CLAIMS      C1: <claim> | SOURCE: <link>            (its own report)
 *   VERDICTS    B1: CONFIRMED                           (on the others' claims)
 *               B2: CHALLENGED | <why> | SOURCE: <link>
 *               B3: UNVERIFIED | <why>
 *   RESPONSES   A2: CONCEDED | <what changed its mind>  (to challenges on its own)
 *               A2: DEFENDED | FACT | <evidence> | SOURCE: <link>
 *               A2: DEFENDED | JUDGMENT | <why it is a matter of weighing>
 *   and, in a round on open disputes, a challenger's
 *               A2: WITHDRAWN | <what settled it>
 *               A2: MAINTAINED | <evidence> | SOURCE: <link>
 *
 * The app, not a model's summary, then knows which claims another model
 * confirmed, which were conceded and which are still disputed. A line the app
 * cannot read is ignored: the claim stays as it was.
 *
 * Everything here works on a Collab passed in (a draft inside updateCollab, or
 * a copy): no store, no clock.
 */
import type { Claim, ClaimVerdict, Collab } from "./collab.js";

export const MAX_CLAIMS_PER_MEMBER = 12;
const TEXT_MAX = 500;
const URL = /https?:\/\/[^\s)|>\]"']+/;
const BULLET = String.raw`^[\s>*\-•]*`;

/** unchecked: no other member gave a verdict. unverified: none could check it. */
export type ClaimStatus = "unchecked" | "confirmed" | "unverified" | "conceded" | "disputed";

function clean(line: string): string {
  return line.replace(/\*\*|`/g, "").trim();
}

/** The link in a line's SOURCE part, else the first link in it. */
function sourceIn(rest: string): string {
  const marked = /SOURCES?\s*:\s*(.+)$/i.exec(rest);
  return (URL.exec(marked ? marked[1] : rest)?.[0] ?? "").replace(/[.,;]+$/, "");
}

/** A line's words without its SOURCE part and separators. */
function wordsIn(rest: string): string {
  return rest.replace(/\|?\s*SOURCES?\s*:.*$/i, "").replace(/^[\s|:\-–—]+|[\s|]+$/g, "").replace(/\s*\|\s*/g, " — ").slice(0, TEXT_MAX);
}

/** The key claims a report lists, with ids `<letter><n>`. Reads the lines
 *  after the last CLAIMS heading, or every line when there is none. */
export function parseClaims(report: string, letter: string): Claim[] {
  const lines = report.split(/\r?\n/).map(clean);
  const heading = lines.map((l) => /^#*\s*(KEY\s+)?CLAIMS\s*:?$/i.test(l)).lastIndexOf(true);
  const row = new RegExp(`${BULLET}C(\\d{1,2})\\s*[:.)]\\s*(.+)$`, "i");
  const claims: Claim[] = [];
  for (const line of lines.slice(heading + 1)) {
    const m = row.exec(line);
    if (!m) continue;
    const id = `${letter}${Number(m[1])}`;
    const text = wordsIn(m[2]);
    if (!text || claims.some((c) => c.id === id)) continue;
    claims.push({ id, owner: letter, text, source: sourceIn(m[2]), verdicts: [] });
    if (claims.length >= MAX_CLAIMS_PER_MEMBER) break;
  }
  return claims;
}

/** Every `<id>: <WORD> rest` line of a reply, for the words given. */
function idLines(reply: string, words: string[]): Array<{ id: string; word: string; rest: string }> {
  const row = new RegExp(`${BULLET}\\[?([A-D]\\d{1,2})\\]?\\s*[:.)\\-–—]\\s*(${words.join("|")})\\b(.*)$`, "i");
  const out: Array<{ id: string; word: string; rest: string }> = [];
  for (const line of reply.split(/\r?\n/).map(clean)) {
    const m = row.exec(line);
    if (m) out.push({ id: m[1].toUpperCase(), word: m[2].toUpperCase(), rest: m[3] });
  }
  return out;
}

function liveChallenges(claim: Claim): ClaimVerdict[] {
  return claim.verdicts.filter((v) => v.verdict === "challenged" && !v.withdrawn);
}

export function claimStatus(claim: Claim): ClaimStatus {
  if (claim.response?.kind === "conceded") return "conceded";
  if (liveChallenges(claim).length) return "disputed";
  if (claim.verdicts.some((v) => v.verdict === "confirmed" || v.withdrawn)) return "confirmed";
  return claim.verdicts.length ? "unverified" : "unchecked";
}

/** The claims still disputed. `factOnly`: without those defended as a matter
 *  of judgment, which more evidence will not settle. */
export function openDisputes(c: Collab, factOnly = false): Claim[] {
  return c.claims.filter((x) => claimStatus(x) === "disputed" && !(factOnly && x.response?.judgment));
}

/** The members' letters that challenge `claim` and have not taken it back. */
export function challengersOf(claim: Claim): string[] {
  return liveChallenges(claim).map((v) => v.by);
}

/** Record `letter`'s verdicts on the other members' claims; one per claim, the first it gave. */
export function applyVerdicts(c: Collab, letter: string, reply: string): number {
  let taken = 0;
  for (const line of idLines(reply, ["CONFIRMED", "CHALLENGED", "UNVERIFIED"])) {
    const claim = c.claims.find((x) => x.id === line.id);
    if (!claim || claim.owner === letter || claim.verdicts.some((v) => v.by === letter)) continue;
    claim.verdicts.push({ by: letter, verdict: line.word.toLowerCase() as ClaimVerdict["verdict"], why: wordsIn(line.rest), source: sourceIn(line.rest) });
    taken++;
  }
  return taken;
}

/**
 * Record what `letter` said in an answer or a round on open disputes: as the
 * maker of a claim, CONCEDED or DEFENDED; as its challenger, WITHDRAWN or
 * MAINTAINED. Only a claim that is disputed takes one.
 */
export function applyResponses(c: Collab, letter: string, reply: string): void {
  for (const line of idLines(reply, ["CONCEDED", "DEFENDED", "WITHDRAWN", "MAINTAINED"])) {
    const claim = c.claims.find((x) => x.id === line.id);
    if (!claim || claimStatus(claim) !== "disputed") continue;
    const mine = claim.owner === letter;
    if (mine && (line.word === "CONCEDED" || line.word === "DEFENDED")) {
      const judgment = line.word === "DEFENDED" && /^[\s|:\-–—]*JUDG(E)?MENT\b/i.test(line.rest);
      const rest = line.rest.replace(/^[\s|:\-–—]*(FACT|JUDG(E)?MENT)\b/i, "");
      claim.response = { kind: line.word === "CONCEDED" ? "conceded" : "defended", judgment, text: wordsIn(rest), source: sourceIn(rest) };
      continue;
    }
    const challenge = mine ? undefined : claim.verdicts.find((v) => v.by === letter && v.verdict === "challenged" && !v.withdrawn);
    if (!challenge) continue;
    if (line.word === "WITHDRAWN") { challenge.withdrawn = true; challenge.why = wordsIn(line.rest) || challenge.why; }
    if (line.word === "MAINTAINED") { challenge.why = wordsIn(line.rest) || challenge.why; challenge.source = sourceIn(line.rest) || challenge.source; }
  }
}

/** Where every open dispute stands: unchanged across a round, nobody moved. */
export function disputeSignature(c: Collab): string {
  return openDisputes(c).map((x) => `${x.id}:${challengersOf(x).sort().join("")}`).join(",");
}

/** The ids of the open disputes `text` does not name. */
export function disputesMissingFrom(c: Collab, text: string): string[] {
  return openDisputes(c).map((x) => x.id).filter((id) => !new RegExp(`\\b${id}\\b`).test(text));
}
