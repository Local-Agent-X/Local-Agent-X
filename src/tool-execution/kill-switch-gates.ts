/**
 * Category kill-switch gates — the declarative registry behind pre-dispatch's
 * "Settings → Security → Tool Policy" blocks.
 *
 * Why a table instead of per-gate throw sites: the four hand-written gates
 * drifted — three recovery strings named the `setting` affordance with the
 * exact field, the computer-control one didn't, and a live agent (2026-07-20)
 * that read "disabled in Settings → Security → Tool Policy" went off guessing
 * at POST /api/tool-policy/toggle (wrong layer, 400) instead of calling
 * `setting`. Generating reason/recovery from one template makes the
 * affordance line structurally impossible to omit, and the contract test
 * (kill-switch-gates.test.ts) pins the invariants: every gate's field exists
 * in FLIPPABLE_SETTINGS as a protected setting, and every "Category
 * kill-switch" setting in the schema has a matching gate here.
 */
import type { LAXConfig } from "../types.js";

/** Config fields that act as category kill-switches over tool dispatch. */
export type KillSwitchField =
  | "enableShell"
  | "enableHttp"
  | "enableBrowser"
  | "enableComputerControl";

export interface KillSwitchGate {
  /** FLIPPABLE_SETTINGS field this gate reads (must be protected:true there). */
  field: KillSwitchField;
  /** Human category name used in the reason line ("Shell Access is disabled…"). */
  label: string;
  /** Grammatical number of the label ("HTTP Requests ARE disabled"). */
  plural?: boolean;
  /** Which tool names the switch covers. */
  matches: (toolName: string) => boolean;
  /** Optional gate-specific tail appended to the generated recovery text. */
  extraRecovery?: string;
}

export const KILL_SWITCH_GATES: ReadonlyArray<KillSwitchGate> = [
  {
    // Covers every shell-class tool, not just `bash`: the process_* family
    // spawns the same /bin/bash -c (or powershell) subprocess, so leaving
    // them on while Shell is off would silently bypass the user's toggle.
    field: "enableShell",
    label: "Shell Access",
    matches: (t) => t === "bash" || t.startsWith("process_"),
    extraRecovery: "Other tools (write/edit/http_request) still work.",
  },
  {
    field: "enableHttp",
    label: "HTTP Requests",
    plural: true,
    matches: (t) => t === "http_request",
  },
  {
    field: "enableBrowser",
    label: "Browser",
    matches: (t) => t.startsWith("browser"),
  },
  {
    // High-risk opt-in, off by default. On macOS the OS Accessibility
    // permission is ALSO required — that's enforced in the driver; here we
    // gate on the user-facing kill-switch.
    field: "enableComputerControl",
    label: "Computer control (mouse/keyboard)",
    matches: (t) => t === "computer",
    extraRecovery:
      "On macOS the OS Accessibility permission is also required (System Settings → Privacy & Security → Accessibility) — the setting alone isn't enough there.",
  },
];

export interface KillSwitchBlock {
  field: KillSwitchField;
  reason: string;
  recovery: string;
}

/**
 * The one recovery template every gate shares. Naming the `setting` tool AND
 * the exact field is the load-bearing part: protected settings route through
 * interactive user approval, so pointing the agent here is safe — it can
 * REQUEST the flip but can never silently apply it.
 */
function recoveryFor(gate: KillSwitchGate): string {
  const base =
    `${gate.label} is off. Tell the user, and ask if they'd like it on. ` +
    `If they confirm, call \`setting\` with ${gate.field}=true — this is the ONLY switch for it ` +
    `(it is NOT a tool-policy rule; /api/tool-policy/toggle will not unblock it). ` +
    `Don't re-enable it on your own just to get past this block.`;
  return gate.extraRecovery ? `${base} ${gate.extraRecovery}` : base;
}

/**
 * Evaluate the kill-switch table for a tool call. Returns the block payload
 * when a matching category is flipped off, else null. Only an explicit
 * `false` blocks — absent/undefined fields fail open, matching the historic
 * per-gate `cfg.enableX === false` checks.
 */
export function killSwitchBlock(
  toolName: string,
  cfg: Partial<Pick<LAXConfig, KillSwitchField>>,
): KillSwitchBlock | null {
  for (const gate of KILL_SWITCH_GATES) {
    if (!gate.matches(toolName)) continue;
    if (cfg[gate.field] !== false) continue;
    return {
      field: gate.field,
      reason: `${gate.label} ${gate.plural ? "are" : "is"} disabled in Settings → Security → Tool Policy.`,
      recovery: recoveryFor(gate),
    };
  }
  return null;
}
