/**
 * Rule registry — the one id space for behavioural rules we actually deliver.
 *
 * WHY THIS EXISTS. A behavioural rule reaches the model through one of five
 * unrelated shapes: prose inside a `## ` part of config/system-prompt.md, a
 * tool description, a tool error message, a turn-loop nudge, or a provider /
 * chat rider. Those shapes share no id space, so nothing could answer "is rule
 * X actually delivered to this model on this turn?". Since commit a52b7aa2 the
 * base prompt is split into priced parts and the allocator SHEDS them on small
 * local windows (context/prompt-degradation.ts) — the "How to work" part alone
 * is 12,236 tokens and is dropped on every 65k local model. A rule whose only
 * home is a shed part silently stops being delivered and no test notices.
 *
 * WHAT THIS IS. A plain exported const: the rules that actually bit us, each
 * with the channels that carry it, every channel verified against real code
 * (file:line cited per entry). It is a description of what EXISTS — not a
 * framework. No registration, no discovery, no plugins. `rule-coverage.test.ts`
 * reads it and fails when a rule's only channel is shed for a profile.
 *
 * ADDING A RULE: point at the delivery first. If you cannot cite the file and
 * line that puts the words in front of the model, the rule does not belong here.
 */

import { WIRE_FORMAT_NUDGE_ID } from "../canonical-loop/public/nudge-ids.js";
import { CHAT_RIDER_IDS } from "../routes/chat/system-prompt-augmentations.js";
import type { RenderedPromptSection } from "./system-prompt-builder.js";

/**
 * The part ids a rendered prompt actually carries — "was part X included?" in
 * one place. Feed it either `buildWithTelemetry().renderedSections` (everything
 * the builder produced) or the `sections` the capability allocator kept
 * (context/prompt-degradation.ts), which is the set that reached the model.
 *
 * It lives here rather than on the builder only because
 * system-prompt-builder.ts sits at 399 of its 400 permitted LOC and has no
 * room for another export; it reads the builder's own RenderedPromptSection.
 */
export function includedPartIds(sections: readonly RenderedPromptSection[]): Set<string> {
  return new Set(sections.map((section) => section.id));
}

/**
 * How a rule reaches the model.
 *
 * `prompt-part` is the ONLY shed-able kind — `part` is a rendered section id
 * (context/system-prompt-builder.ts), e.g. `core-identity/how-to-work` for a
 * `## ` heading of config/system-prompt.md, or a builder-owned id such as
 * `runtime-context`. Every other kind rides a channel the prompt allocator
 * never touches: tool schemas and tool errors are assembled per call, nudges
 * are appended as messages, riders are appended after allocation.
 */
export type RuleChannel =
  | { kind: "prompt-part"; part: string }
  | { kind: "tool-description"; tool: string }
  | { kind: "error-message"; source: string }
  | { kind: "nudge"; id: string }
  | { kind: "rider"; id: string };

export interface Rule {
  id: RuleId;
  /** One line, human — what the model is being told. */
  summary: string;
  channels: RuleChannel[];
}

export type RuleId =
  | "shell-posix-not-powershell"
  | "long-running-process-uses-process-start"
  | "terminal-work-is-never-a-handoff"
  | "never-act-on-your-own-offer"
  | "search-defaults-to-project-root"
  | "edit-requires-exact-match"
  | "tool-call-must-be-structured-not-text"
  | "memory-search-when-unknown"
  | "read-before-you-change";

export const RULES: Record<RuleId, Rule> = {
  // The `bash` tool runs POSIX sh even on Windows. Delivered three ways, so a
  // shed prompt part cannot silence it.
  //   prompt-part: src/context/system-prompt-builder.ts:214-231 — the
  //     `runtime-context` section ("Default shell for the `bash` tool: …",
  //     "Use POSIX verbs" / "Use PowerShell verbs"). policy `required`,
  //     priority `safety` ⇒ never a shed candidate.
  //   tool-description: src/tools/shell-tool.ts:13-15 — "Run a shell command
  //     (bash; Git Bash on Windows, else PowerShell — write POSIX sh)".
  //   error-message: src/tools/shell-translate.ts:39-50 powershellCmdletHint —
  //     "'Get-ChildItem' is a PowerShell cmdlet, but the bash tool runs POSIX sh."
  "shell-posix-not-powershell": {
    id: "shell-posix-not-powershell",
    summary: "The bash tool runs POSIX sh — PowerShell cmdlets are not commands there.",
    channels: [
      { kind: "prompt-part", part: "runtime-context" },
      { kind: "tool-description", tool: "bash" },
      { kind: "error-message", source: "src/tools/shell-translate.ts powershellCmdletHint" },
    ],
  },

  // A server started with plain `bash` blocks the turn and times out.
  //   prompt-part: config/system-prompt.md:113 ("Long-running process … call
  //     `process_start`") — inside `## How to work`, class `tuning`
  //     (src/config-loader.ts:105), so SHED on both local profiles.
  //   error-message: src/tools/shell-tool.ts:254 — the timeout recovery line
  //     "use process_start for long-running commands". This is what actually
  //     reaches a local model.
  "long-running-process-uses-process-start": {
    id: "long-running-process-uses-process-start",
    summary: "Start long-running processes with process_start, never a blocking bash call.",
    channels: [
      { kind: "prompt-part", part: "core-identity/how-to-work" },
      { kind: "error-message", source: "src/tools/shell-tool.ts bash timeout recovery" },
    ],
  },

  // prompt-part ONLY: config/system-prompt.md:112-118, inside `## How to work`.
  // Searched src/canonical-loop, src/agent-request and src/routes/chat for a
  // hand-off detector — browser-handoff.ts covers the BROWSER case, nothing
  // covers "run this command yourself". No tool description or error says it.
  "terminal-work-is-never-a-handoff": {
    id: "terminal-work-is-never-a-handoff",
    summary: "Never tell the user to run a command — you have bash and process_start.",
    channels: [{ kind: "prompt-part", part: "core-identity/how-to-work" }],
  },

  // prompt-part ONLY: config/system-prompt.md:46 ("Never act on your own
  // offer"), inside `## How to work`. Grepped src/**/*.ts and config/*.md —
  // this text exists in exactly one place.
  "never-act-on-your-own-offer": {
    id: "never-act-on-your-own-offer",
    summary: "A question you ended your reply with ends the turn — wait for the answer.",
    channels: [{ kind: "prompt-part", part: "core-identity/how-to-work" }],
  },

  // Commit 7e80bec6 — glob/grep with no path used to search process.cwd().
  //   tool-description: src/tools/glob-tool.ts:149,165 and
  //   src/tools/grep-tool.ts:249 — "defaults to the project root (the same
  //   root relative paths in read/bash resolve against)".
  "search-defaults-to-project-root": {
    id: "search-defaults-to-project-root",
    summary: "glob/grep with no path search the project root, the same root read and bash use.",
    channels: [
      { kind: "tool-description", tool: "glob" },
      { kind: "tool-description", tool: "grep" },
    ],
  },

  //   tool-description: src/tools/edit-tools.ts:123,131 — "Matching tolerates
  //     CRLF/indentation but the content must match exactly".
  //   error-message: src/tools/edit-tools.ts:69,90 — "old_string not found. …
  //     Make sure it matches exactly." plus the nearby-lines recovery hint.
  "edit-requires-exact-match": {
    id: "edit-requires-exact-match",
    summary: "edit replaces an exact substring; a near-miss old_string fails rather than guesses.",
    channels: [
      { kind: "tool-description", tool: "edit" },
      { kind: "error-message", source: "src/tools/edit-tools.ts applyStringEdit failure" },
    ],
  },

  //   nudge: src/canonical-loop/turn-loop/nudges.ts:25 WIRE_FORMAT_NUDGE, fired
  //     by the unresolved-tool-intent gate (turn-loop/tool-intent-gate.ts:113).
  //   rider: src/routes/chat/system-prompt-augmentations.ts:94-108 — the
  //     TOOL-CALL REQUIRED block after a 3-turn prose streak.
  //   rider: src/agent-request/prepare-request/provider-riders.ts:91 rule 1 of
  //     BASE_LOCAL_RIDER — appended on EVERY local turn, after allocation.
  "tool-call-must-be-structured-not-text": {
    id: "tool-call-must-be-structured-not-text",
    summary: "A tool call written as text runs nothing — emit the native structured call.",
    channels: [
      { kind: "nudge", id: WIRE_FORMAT_NUDGE_ID },
      { kind: "rider", id: CHAT_RIDER_IDS.toolCallRequired },
      { kind: "rider", id: "local-model-rider" },
    ],
  },

  //   prompt-part: src/context/system-prompt-builder.ts:289-299 — the
  //     `recall-reflex` section ("Call `search_past_sessions` when it doesn't
  //     cover the reference"). policy `required`, priority `safety` ⇒ never shed.
  //   prompt-part: config/system-prompt.md:383 `## Memory — relational`, class
  //     `navigation` (src/config-loader.ts:103) — shed-able, the backup copy.
  "memory-search-when-unknown": {
    id: "memory-search-when-unknown",
    summary: "Search past sessions before guessing at a project, brand or person you don't recognize.",
    channels: [
      { kind: "prompt-part", part: "recall-reflex" },
      { kind: "prompt-part", part: "core-identity/memory" },
    ],
  },

  //   prompt-part: config/system-prompt.md:249 `## Coding discipline`, class
  //     `tuning` (src/config-loader.ts:106) — shed on the 32k profile.
  //   prompt-part: AGENTS.md:62 "**Read before edit.**", injected verbatim by
  //     the `agents-md` builder section (system-prompt-builder.ts:249-267),
  //     policy `required` / priority `safety` ⇒ never shed. This is the copy
  //     that survives.
  "read-before-you-change": {
    id: "read-before-you-change",
    summary: "Never edit code you haven't opened — read the function and its call sites first.",
    channels: [
      { kind: "prompt-part", part: "core-identity/coding-discipline" },
      { kind: "prompt-part", part: "agents-md" },
    ],
  },
};

/** Every rule, in declaration order. */
export function allRules(): Rule[] {
  return Object.values(RULES);
}

/**
 * True when `channel` reaches the model given the prompt parts that survived
 * the allocator. Only `prompt-part` can be shed; every other kind is assembled
 * outside the prompt budget and always counts.
 */
export function channelIsDelivered(channel: RuleChannel, includedParts: ReadonlySet<string>): boolean {
  return channel.kind === "prompt-part" ? includedParts.has(channel.part) : true;
}

/** The channels of `rule` that survive for a profile whose prompt kept `includedParts`. */
export function deliveredChannels(rule: Rule, includedParts: ReadonlySet<string>): RuleChannel[] {
  return rule.channels.filter((channel) => channelIsDelivered(channel, includedParts));
}
