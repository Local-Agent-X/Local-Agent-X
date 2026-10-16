// Shared type definitions for the unified per-tool policy table. The table
// itself is assembled from per-domain fragments and merged in tool-policies.data.ts;
// these interfaces are the contract every fragment is typed against. They are
// re-exported unchanged from tool-policies.data.ts so existing importers (and
// tool-registry.ts) keep their import path.

import type { KernelClass, ToolRisk } from "../tool-registry.js";
import type { ToolPolicyRule } from "./types.js";

export interface ToolRateLimit {
  maxCalls: number;
  windowMs: number;
  action: "block" | "warn" | "throttle";
}

// A caller-supplied filesystem path that a tool opens. Declaring it here is
// what subjects the tool to the file-access mode (workspace/common/unrestricted)
// — SecurityLayer.evaluate() runs EVERY declared arg through evaluateFileAccess
// before dispatch, so the mode is a uniform hard boundary across every file sink
// (raw read/write, spreadsheet, document, presentation, pdf, ocr, image, search)
// rather than just the four raw fs tools. A tool that opens a path WITHOUT a
// declaration here silently bypasses confinement — that was the office-doc
// breach. The coverage test in tool-policies.test.ts guards the known sinks.
export interface PathArgSpec {
  /** Argument name holding the path (e.g. "file_path", "path", "output_path"). */
  arg: string;
  /** Action token handed to evaluateFileAccess. Every action but "read" is
   *  refused, in every mode, for the security control files (isLaxControlFile)
   *  and the install folder. "write"/"edit" add write-confinement + core-file
   *  protection; "delete_file" is otherwise confined as a read is. */
  action: "read" | "write" | "edit" | "delete_file";
  /** Arg value is a JSON-array string of paths (pdf merge.files). Each element
   *  is gated independently. Any arg may also arrive as a real array of
   *  strings; a non-string element fails closed. */
  json?: boolean;
  /** Arg value is an array of objects and the path lives under this key of
   *  each element (op_submit_batch.tasks[].context_files). */
  each?: string;
  /** For collapsed one-tool-many-actions families: this spec applies only when
   *  the call's `args.action` is in the list. A tool that declares ANY
   *  forActions spec is fail-closed — a call whose args.action matches no
   *  declared spec is denied, so an undeclared action can never open a path
   *  ungated. Omit for tools whose path gating is action-independent. */
  forActions?: string[];
  /** The path is a directory a search walks, defaulting to the run's root: in
   *  an agent's worktree an omitted or out-of-tree root is clamped to the
   *  worktree (tool-execution/worktree-paths.ts) instead of opened. */
  searchRoot?: true;
  /** After the call succeeds the session knows this one file's current bytes —
   *  it read them, or it wrote them. An `edit` spec carrying it also requires
   *  that knowledge first: an in-place edit is refused against a file that
   *  changed since the session last saw it (tool-execution/run-sandboxed.ts
   *  stale-read guard). */
  knowsContent?: true;
}

/**
 * The I/O-sink classes a tool declares on its own row. The gates key on these
 * (tool-registry.ts hasCapability), never on tool names, so a synonym is gated
 * the day its row says what it does.
 *   egress         — can carry model-supplied data off the box, or into another
 *                    app or process (an exfiltration sink)
 *   sensitive-read — its result can put file, secret or private content in
 *                    front of the model
 *   shell          — spawns a subprocess or runs an arbitrary command
 * A tool that writes files is not declared: its pathArgs say which paths a call
 * writes, edits or deletes, and the workspace-write class is derived from them.
 * No tool may be both egress and sensitive-read (tool-registry.ts
 * validateCapabilitySets).
 */
export type DeclaredCapability = "egress" | "sensitive-read" | "shell";

/**
 * What a tool's result carries, where masking and taint must treat it apart
 * from the rest (tool-execution/sensitive-read-taint.ts, private-read-record.ts):
 *   command      — a command's stdout/stderr (a dev server printing its env is
 *                  the same channel as `cat .env`)
 *   http-body    — a fetched response body (endpoint-aware masking; its tokens
 *                  vouch for a later send back to the same site)
 *   file-content — a file read by path: taint follows the path, and only
 *                  registered secret values are masked
 *   mailbox      — mail the user received: private content they hold
 */
export type OutputKind = "command" | "http-body" | "file-content" | "mailbox";

/**
 * Where a send delivers (tool-execution/send-destinations.ts resolves it): the
 * private-content gate names it on its card, an "always allow" is keyed on it,
 * the outbound secret scan picks its allowlist from it, and site provenance
 * vouches for tokens the destination site showed.
 *   site           — the site the URL in `arg` reaches. `allowlisted`: the host
 *                    allowlist exempts it, and the call is scanned as a request
 *                    (url, method, body, headers)
 *   recipients     — every email address in `args`; the user's own address and
 *                    allowlisted domains are trusted
 *   chat           — a messaging chat the user authorized in Settings, by `arg`
 *   user           — only the user (their device, clipboard, own channel);
 *                    `message`: delivered as a message or file over a channel
 *   service        — a fixed third-party service
 *   browser-page   — the page the session's browser is on, or the sites a
 *                    navigation names (live state)
 *   foreground-app — the desktop app with the foreground (live state)
 *   unknown        — somewhere the check cannot name, described by `label`
 * A spec with `forActions` applies to those actions only, in place of the
 * unscoped ones.
 */
export type DestinationSpec = (
  | { to: "site"; arg: string; allowlisted?: true }
  | { to: "recipients"; args: readonly string[] }
  | { to: "chat"; app: "Telegram" | "WhatsApp"; arg: string }
  | { to: "user"; message?: true }
  | { to: "service"; name: string }
  | { to: "browser-page" }
  | { to: "foreground-app" }
  | { to: "unknown"; label: string }
) & { forActions?: readonly string[] };

/**
 * How a destructive tool's effect is undone (tools/undo-pairs.ts reads it):
 *   pairedWith    — the tool that reverses it; a tool set that carries one
 *                   carries both, so one wrong call is never unrecoverable
 *   recoverable   — undone without a pair (why); the irreversible floor does
 *                   not card it
 *   irreversible  — nothing undoes it (why): the approval gate is the only
 *                   protection, and the irreversible floor (irreversible-tools.ts)
 *                   cards it in an interactive run unless `uncarded` says why
 *                   not. `previewsUntil` names the arg that must be `true` for
 *                   the call to destroy anything (a forget previews first).
 */
export type UndoSpec =
  | { pairedWith: string }
  | { recoverable: string }
  | { irreversible: string; uncarded?: string; previewsUntil?: string };

/** What the user loses if a tool fires unapproved (feeds TOOL_RISK). A
 *  destructive tool must say how its effect is undone, and only it may. */
type RiskFacts =
  | { risk: "destructive"; undo: UndoSpec }
  | { risk: Exclude<ToolRisk, "destructive">; undo?: undefined };

/**
 * The action the Ari kernel judges a call as (tool-execution/ari-action-map.ts
 * ariActionOf). It must be valid for the row's kernel class in the kernel's
 * HOST_CAPABILITY_MANIFEST — `exec` only for shell — or every call throws and
 * blocks under ariRequired. Either one verb, or a verb read off an argument: a
 * value in `writes` (any case) is a write, judged as `as` or as that value
 * lowercased, and anything else as "get" — so a POST or a browser click reads
 * as a write to a preset that denies tainted writes.
 */
export type AriActionSpec = string | { arg: string; writes: readonly string[]; as?: string };

/** The kernel defense pipeline (feeds TOOLS / TOOL_CLASS_MAP). A tool the
 *  kernel checks must say which action it is judged as; an internal tool
 *  never reaches the kernel. */
type KernelFacts =
  | { kernel: "internal"; ariAction?: undefined }
  | { kernel: Exclude<KernelClass, "internal">; ariAction: AriActionSpec };

/**
 * A result that depends on state that changes between identical calls, so a
 * repeat must run again rather than be answered from an earlier result (the
 * 60 s dedup cache, the session-wide repeat skip):
 *   poll   — and an identical repeat is how the tool is used (waiting on an op,
 *            a process, a page), so the threat engine's repeat and ping-pong
 *            loop arms exempt it; its 40-call breaker still applies
 *   fresh  — a changing answer (a task list, the tool catalog, a person's
 *            reply), still loop-guarded like any other call
 */
export type LiveState = "poll" | "fresh";

/** One concrete tool's row. Every fact a gate needs about the tool lives here,
 *  so a new tool answers each question once, and the type will not build
 *  without the answers. */
export type ToolPolicyRow = ToolPolicyRowFacts & RiskFacts & KernelFacts;

interface ToolPolicyRowFacts {
  /** How long a call may run before the harness abandons it (tool-timeout.ts);
   *  0 is unbounded, for a tool that legitimately runs for minutes. A tool
   *  without one gets the 120 s fallback. */
  timeoutMs?: number;
  /** See LiveState. */
  liveState?: LiveState;
  /** For a collapsed one-tool-many-actions family whose risk is not
   *  destructive as a whole: the actions that are, each with what it destroys
   *  (approval-decision.ts destructiveOperationReason). */
  destructiveActions?: Readonly<Record<string, string>>;
  /** The sink classes this tool belongs to; `[]` when none. */
  capabilities: readonly DeclaredCapability[];
  /** A model-authored shell command the tool runs: the arg holding it, and
   *  whether the call returns only once the command has exited (bash) rather
   *  than leaving it running (process_start, the dev servers). Every command
   *  gate reads it through shellCommandOf (tool-registry.ts): the destructive
   *  floor, the publish gate, the delete gates, the verify gate; a check of
   *  what the command DID (a delete really happened, tier-0 auto-allow) needs
   *  waitsForExit. */
  shellCommand?: { arg: string; waitsForExit?: true };
  /** What the result carries, when masking or taint must know (OutputKind). */
  output?: OutputKind;
  /** A successful result puts text authored off this computer in front of the
   *  model (a fetched page, a search result, mail, a folder name a server chose)
   *  — untrusted content that blocks the turn from auto-promoting memory. */
  externalContent?: true;
  /** Where a send delivers (DestinationSpec). A tool that sends with none is
   *  sending to an unknown destination: asked about, never waved through. */
  destination?: readonly DestinationSpec[];
  /** Explicit policy rule(s). `tool` is stamped from the record key by
   *  deriveDefaultRules — omit it here. */
  rules?: Array<Omit<ToolPolicyRule, "tool">>;
  /** Sliding-window rate cap (was DEFAULT_LIMITS in tool-execution/rate-limiter.ts). */
  rateLimit?: ToolRateLimit;
  /** Caller-supplied file path arg(s) this tool opens — gated through the file-
   *  access mode by SecurityLayer, and the source of the workspace-write class.
   *  See PathArgSpec. */
  pathArgs?: PathArgSpec[];
  /** This tool's implementation performs a NON-loopback fetch/upload with
   *  model-controlled content (a query/prompt/body/path that rides off-box to a
   *  remote API or messaging bridge). Every such tool also declares "egress"
   *  (capability-class-gates.test.ts). A tool that only hits loopback (localhost
   *  Stable Diffusion / 127.0.0.1) is NOT off-box and must NOT be marked. */
  offBoxFetch?: boolean;
}

/** A glob family ("memory_*") or the global "*" cap: a shared rule or rate
 *  limit, never a tool's facts. */
export interface GlobPolicyEntry {
  rules?: Array<Omit<ToolPolicyRule, "tool">>;
  rateLimit?: ToolRateLimit;
  kernel?: undefined;
  risk?: undefined;
  capabilities?: undefined;
  shellCommand?: undefined;
  output?: undefined;
  externalContent?: undefined;
  destination?: undefined;
  undo?: undefined;
  destructiveActions?: undefined;
  ariAction?: undefined;
  timeoutMs?: undefined;
  liveState?: undefined;
  pathArgs?: undefined;
  offBoxFetch?: undefined;
}

export type ToolPolicyEntry = ToolPolicyRow | GlobPolicyEntry;
