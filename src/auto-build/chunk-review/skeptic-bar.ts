/**
 * What a skeptic's finding must show to count against a chunk.
 *
 * The skeptic used to have no bar: "prove it wrong, default to broken if
 * unsure", and any one input it could break sent the chunk back. A parser for
 * free text has no end of odd inputs and every skeptic starts fresh, so
 * label-check's chunk 3 was rebuilt some twenty times in a day, each builder
 * green on its tests and each skeptic finding a line the spec never named
 * (2026-11-23). Each finding was then written into the plan as a requirement,
 * so the target moved with every round.
 *
 * The bar is the /greenfield skill's (references/autonomous.md, section 6): a
 * chunk is held to its contract, and what a skeptic finds beyond the contract
 * is a follow-up for the ledger. The grounds below are the skill's own words;
 * skeptic.test.ts fails when the bundled skill stops saying them.
 */

/** The only things that make a change BROKEN. */
export const SKEPTIC_BREAK_GROUNDS: readonly string[] = [
  "a done-when line or a `spec/` rule the change breaks, quoted as written",
  "a crash, lost or corrupted data, or a security hole",
  "a test that cannot fail, or a claim in the builder's report the code does not back",
];

/**
 * How far a rule over open-ended input reaches. "A missing entry is never
 * acceptable" covers every label anyone could type, so a skeptic could always
 * quote it for one more odd input and the bar above bounded nothing. The plan
 * marks such a rule strict or scoped where it states it (the skill's
 * references/spec.md, section 8); the skeptic reads the mark. The skill's own
 * sentences, pinned like the grounds.
 */
export const SKEPTIC_RULE_REACH: readonly string[] = [
  "A rule over open-ended input (any text, file or label a person might bring) reaches as far as it is marked.",
  "A `strict` rule must hold for every input: one input that breaks it is a break.",
  "A `scoped` rule is judged on the examples listed with it and on inputs of the same kind: an input of a new kind is a follow-up.",
  "A rule that is not marked is scoped.",
];

/**
 * A finish fix is checked against what it was given to fix. The break-it
 * agents attack the whole finished app every finish round; a fix chunk's
 * skeptic attacking the whole app again after every fix round turned 14
 * findings into two hours per fix chunk, each round closing what it was given
 * and the next skeptic finding something else that was already there
 * (label-check-sol, 2026-11-25). The skill's finish step is "fix what is found
 * and re-judge" (references/gates.md): the next round finds the rest.
 */
export const FINISH_FIX_BREAK_GROUNDS: readonly string[] = [
  "a finding the chunk was given still reproduces, as described or with an input of the same kind",
  "its test passes on the code from before the chunk",
  "the chunk's change breaks something that worked before it",
  "a crash, lost or corrupted data, or a security hole",
];

/**
 * What every worker sent to fix a finding is told, the fixer's half of the
 * reviewer's "or with an input of the same kind" above. The reviewer was
 * told to try a finding's siblings and the fixer was never told to fix them:
 * a Grok finish fix spent six rounds on one finding, each round patching the
 * example and the reviewer breaking it with the next character or the next
 * spelling of the same drug (label-check-grok, 2026-11-26). The owner asked
 * why the agents were not fixing the class.
 */
export const FIX_THE_CLASS =
  "Fix the cause, so that every input of the same kind is handled, not only the example the review gave: the reviewer " +
  "will try its siblings (other characters, spellings, sizes, orders, timings of the same kind). Add a test that covers " +
  "those siblings, not only the reported case.";

export const FINISH_FIX_BAR_BLOCK =
  `## This is a finish fix\n\n` +
  `The break-it agents attacked the finished app and this chunk fixes what they found. Check the fix, not the ` +
  `whole app: the break-it agents attack the whole app again in the next finish round. The change is BROKEN ` +
  `only when you show one of:\n` +
  FINISH_FIX_BREAK_GROUNDS.map((ground, i) => `${i + 1}. ${ground};\n`).join("") +
  `\nEverything else is a FOLLOW-UP, including a problem that was already in the app before this chunk (it ` +
  `reproduces at the starting commit) and is none of the above. For a broken verdict, start \`ground\` with ` +
  `the number of the ground you showed ("3 — ...").\n\n`;

/**
 * Whether a BROKEN finish fix leaves the app no worse than before it: the
 * skeptic's ground is 1 or 2 (a finding not fully fixed, a test that cannot
 * fail), not 3 or 4 (the fix broke something, or a crash, lost data or a
 * security hole). A fix out of rounds on such a ground lands what it fixed
 * (loop/handle-push-back.ts); 1012's real fixes sat on a branch instead
 * (label-check-sol, 2026-11-25).
 */
export function finishFixLeavesAppNoWorse(ground: string | undefined): boolean {
  const n = ground?.match(/^\W*(\d)\b/)?.[1];
  return n === "1" || n === "2";
}

/**
 * A chunk sent back is rechecked, not attacked again. Every skeptic started
 * fresh and gave one break, so each fix round closed what it was given and the
 * next skeptic found something else: 97 of 148 send-backs over four days of
 * builds, 113 "broken" verdicts to 24 "holds", and as many hours reviewing as
 * building (2026-11-24 to 27). The first review is the full review and lists
 * every break it finds; a later one is held to that list.
 */
export const RECHECK_BREAK_GROUNDS: readonly string[] = [
  "a finding from the earlier reviews still reproduces, as described or with an input of the same kind",
  "its fix broke something that worked at the last review",
  "a crash, lost or corrupted data, or a security hole",
];

/** The section a recheck's instructions carry, with what the chunk was sent back for. */
export function recheckBlock(earlier: readonly string[]): string {
  const MAX = 1_200;
  const list = earlier.map((f, i) => `${i + 1}. ${f.trim().length > MAX ? `${f.trim().slice(0, MAX)}…` : f.trim()}`).join("\n");
  return (
    `## This is a recheck\n\n` +
    `The chunk was reviewed in full before and sent back for these findings:\n\n${list}\n\n` +
    `Check the fixes, not the whole chunk again. The change is BROKEN only when you show one of:\n` +
    RECHECK_BREAK_GROUNDS.map((ground, i) => `${i + 1}. ${ground};\n`).join("") +
    `\nEverything else is a FOLLOW-UP, including a problem the earlier reviews could have found and did not ` +
    `list. For a broken verdict, start \`ground\` with the number of the ground you showed ("1 — ...").\n\n`
  );
}

/** What a first review is told about how many breaks to give. */
export const LIST_EVERY_BREAK =
  "This is the chunk's one full review: a later review only rechecks what you list. Keep looking after the " +
  "first break and give every break you can show, numbered, in `finding`, each with its ground.";

/** The section of the skeptic's instructions that states the bar. */
export const SKEPTIC_BAR_BLOCK =
  `## What counts as BROKEN\n\n` +
  `The chunk's contract is its slice, its done-when and the project's \`spec/\`. The change is BROKEN ` +
  `only when you show one of:\n` +
  SKEPTIC_BREAK_GROUNDS.map((ground) => `- ${ground};\n`).join("") +
  `\nAnything else you turn up is a FOLLOW-UP, not a break: an input the contract never names, behavior ` +
  `it leaves open, a design or style you would have chosen differently. The contract says what done ` +
  `is; you do not add to it. A follow-up is recorded for the owner and the chunk still passes.\n` +
  `- Unsure whether the change does what the contract says: BROKEN. HOLDS means you tried and the change survived.\n` +
  `- Unsure whether the contract covers the case at all: FOLLOW-UP.\n\n` +
  `${SKEPTIC_RULE_REACH.join(" ")} The plan marks rules; you do not re-mark them.\n\n`;
