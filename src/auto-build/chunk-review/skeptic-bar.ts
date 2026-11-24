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
