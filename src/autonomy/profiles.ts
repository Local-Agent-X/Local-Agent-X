/**
 * Autonomy profiles — map ToolRisk → Decision.
 *
 * A profile is a fixed policy table the user picks once: how should the
 * agent treat each class of tool call? Safe asks for almost everything,
 * Normal is the conservative middle, Developer/Power loosen things for
 * trusted workflows, Autonomous runs unattended with rollback safety
 * nets where the risk is reversible.
 */

import type { ToolRisk } from "./risk.js";

export type Decision = "allow" | "allow-with-rollback" | "ask" | "deny";

export type Profile = {
  name: string;
  rules: Record<ToolRisk, Decision>;
};

// Names exported as a closed set so the store can validate persisted values.
export const PROFILE_NAMES = ["Safe", "Normal", "Developer", "Power", "Autonomous"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

// Shipped default for fresh installs. Power = autonomous for everything except
// money and secrets (those still prompt). Existing users keep whatever their
// ~/.lax/autonomy-profile.json already holds — this only sets the new-user start.
export const DEFAULT_PROFILE: ProfileName = "Power";

// ── Profile tables ──────────────────────────────────────────
//
// "publish" — a git push, deploy, package publish or release. No tool carries
// it statically: a shell call that publishes is RECLASSIFIED to it
// (publish-operation.ts), after a fresh-context review of exactly what would
// ship (tool-execution/publish-review-gate.ts). The row decides every review
// outcome except RED — a red finding blocks under every profile unless the user
// overrides it on the card. So this row is "what happens to a reviewed publish
// that came back GREEN, AMBER, FAILED, or with an unknown change set":
//   Safe, Normal  ask — they already ask before anything leaves the machine
//                 (network-write, external-comms).
//   Developer     ask — its loosening is for reversible work, and rollback
//                 cannot un-push or un-deploy.
//   Power         allow — "autonomous for everything except money and
//                 secrets"; the review, not a prompt, is what makes that safe,
//                 and the model still reads every finding in the tool result.
//   Autonomous    allow — unattended by definition; RED still blocks.

const Safe: Profile = {
  name: "Safe",
  rules: {
    "safe": "allow",
    "network-read": "allow",
    "workspace-write": "ask",
    "shell": "ask",
    "network-write": "ask",
    "external-comms": "ask",
    "destructive": "deny",
    "money": "deny",
    "secrets": "deny",
    "publish": "ask",
  },
};

const Normal: Profile = {
  name: "Normal",
  rules: {
    "safe": "allow",
    "workspace-write": "allow",
    "network-read": "allow",
    "shell": "allow",
    "network-write": "ask",
    "external-comms": "ask",
    "destructive": "ask",
    "money": "ask",
    "secrets": "ask",
    "publish": "ask",
  },
};

const Developer: Profile = {
  name: "Developer",
  rules: {
    "safe": "allow",
    "workspace-write": "allow",
    "network-read": "allow",
    "shell": "allow-with-rollback",
    "network-write": "ask",
    "external-comms": "ask",
    "destructive": "allow-with-rollback",
    "money": "ask",
    "secrets": "ask",
    "publish": "ask",
  },
};

const Power: Profile = {
  name: "Power",
  rules: {
    "safe": "allow",
    "workspace-write": "allow",
    "network-read": "allow",
    "shell": "allow",
    "network-write": "allow",
    "external-comms": "allow",
    "destructive": "allow",
    "money": "ask",
    "secrets": "ask",
    "publish": "allow",
  },
};

// Reversible classes get rollback wrapping; irreversible side effects
// (network-write, external-comms, money, secrets) just run — once sent
// or charged, there's nothing to undo.
const Autonomous: Profile = {
  name: "Autonomous",
  rules: {
    "safe": "allow",
    "workspace-write": "allow-with-rollback",
    "network-read": "allow",
    "shell": "allow-with-rollback",
    "network-write": "allow",
    "external-comms": "allow",
    "destructive": "allow-with-rollback",
    "money": "allow",
    "secrets": "allow",
    "publish": "allow",
  },
};

export const PROFILES: Record<ProfileName, Profile> = {
  Safe,
  Normal,
  Developer,
  Power,
  Autonomous,
};

// ── API ─────────────────────────────────────────────────────

export function getProfile(name: ProfileName): Profile {
  return PROFILES[name];
}

export function decide(profile: Profile, risk: ToolRisk): Decision {
  return profile.rules[risk];
}

export function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string" && (PROFILE_NAMES as readonly string[]).includes(value);
}
