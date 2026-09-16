/**
 * Every place that asks for approval REGARDLESS of the user's autonomy profile,
 * and why the profile does not govern it.
 *
 * The profile table (autonomy/profiles.ts) is how the user says how much they
 * want to be asked. `alwaysAsk: true` overrides that answer. The override is
 * sometimes right and sometimes a bug, and nothing distinguished the two: the
 * browser's sensitive-page gate carried one for months, so a profile set to
 * never ask still raised a card on every cloud-console click and the user had
 * no way to turn it off (live 2026-09-16). It looked exactly like the three
 * legitimate ones below.
 *
 * The line: an override is legitimate only when the prompt protects the USER'S
 * OWN MANDATE — a setting they own, a standing instruction they gave, a
 * quarantine they asked for. It is NOT legitimate for "this action feels risky
 * to the harness"; that judgment is what the profile already encodes, keyed by
 * risk tier.
 *
 * approval-overrides.contract.test.ts scans the source for `alwaysAsk: true`
 * and fails on any site missing here — so the next override is a decision
 * someone writes down, not one that slips in.
 */

export interface AlwaysAskSite {
  /** Source file, relative to src/. */
  file: string;
  /** What is being protected. */
  what: string;
  /** Why the user's profile does not get to waive this. */
  why: string;
}

export const ALWAYS_ASK_SITES: readonly AlwaysAskSite[] = [
  {
    file: "tool-execution/protected-setting-gate.ts",
    what: "changing a user-owned security setting",
    why: "The setting IS the user's answer about what the agent may do. Letting a permissive profile auto-approve edits to it would let the agent widen its own permissions — the profile cannot be the thing that waives control over the profile.",
  },
  {
    file: "tools/plan-tools.ts",
    what: "exit_plan_mode — ending enforced plan mode",
    why: "Plan mode is a standing instruction the user switched on. Only the user ends it; a cached grant or a permissive profile must never end their mandate for them.",
  },
  {
    file: "tools/browser-tools/gates.ts",
    what: "releasing a quarantined browser download into the workspace",
    why: "The quarantine is the user's own boundary between 'the agent fetched a file' and 'that file is loose in my workspace'. One explicit yes per file, per release.",
  },
];

/** The one site that is NOT here on purpose: the sensitive-page ACTION gate in
 *  the same browser file. It asked unconditionally until 2026-09-16 and now
 *  reads the profile like every other tool — an admin-panel click is a risk
 *  judgment, which the profile already makes. Kept as a note so a future reader
 *  does not "restore" it. */
export const DELIBERATELY_NOT_ALWAYS_ASK = [
  "tools/browser-tools/gates.ts: sensitive-page action (profile-governed via getRiskDecision)",
] as const;
