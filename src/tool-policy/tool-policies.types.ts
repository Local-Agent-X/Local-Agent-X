// Shared type definitions for the unified per-tool policy table. The table
// itself is assembled from per-domain fragments and merged in tool-policies.data.ts;
// these interfaces are the contract every fragment is typed against. They are
// re-exported unchanged from tool-policies.data.ts so existing importers (and
// tool-registry.ts) keep their import path.

import type { KernelClass, ToolRisk } from "../tool-registry.js";
import type { ToolPolicyRule } from "./types.js";
import type { CallContext } from "../tool-execution/context.js";
import type { PublishKind } from "../publish-operation-table.js";
import type { IntegrationTransport } from "../integrations/types.js";
import type { ToolSelectionFacts } from "./tool-tags.js";

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
   *  it read them, or it wrote them whole. A spec that changes the file also
   *  requires that knowledge first (tool-execution/run-sandboxed.ts stale-read
   *  guard): an `edit` spec always, since an in-place edit targets bytes the
   *  session must have seen; a `write` spec when the file already exists, since
   *  a whole-file write replaces bytes the session never saw. Creating a file
   *  needs nothing. */
  knowsContent?: true;
  /** The call opens this path only when it passes the arg: left out, the tool
   *  writes nowhere (http_request without save_to returns the body). Absent,
   *  an omitted arg still opens its default (restore_file without destination
   *  writes the file back where it was), so the call counts as writing. Read
   *  by hasCapability's per-call workspace-write answer. */
  whenGiven?: true;
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
 *                    (leaves the box: local-only mode and the egress-refutation
 *                    pack read it). Plan mode admits either form: a plan or
 *                    mockup sent to the user is part of planning
 *   service        — a fixed third-party service
 *   model          — the model this chat runs on, as part of the conversation:
 *                    what `read` hands it already, so no one new receives it
 *                    (view_image, read_video_frames). Resolves to no destination
 *   browser-page   — the page the session's browser is on, or the sites a
 *                    navigation names (live state); `arg` names the URL a
 *                    navigation opens, when the call carries one
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
  | { to: "model" }
  | { to: "browser-page"; arg?: string }
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
 * lowercased, and anything else as `otherwise` ("get" when unset; a file-class
 * tool says "read") — so a POST or a browser click reads as a write to a
 * preset that denies tainted writes. `whenAbsent` is the value the tool itself
 * uses when the call omits the argument (http_request's `method` is "GET"); a
 * gate that names the request it judges reads it from here
 * (tool-registry.ts requestMethodOf). Absent: the tool has no default, and
 * an omitted argument is judged as `otherwise`.
 */
export type AriActionSpec = string | { arg: string; writes: readonly string[]; as?: string; otherwise?: string; whenAbsent?: string };

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

/**
 * State the dispatcher supplies to a call from the run it belongs to
 * (tool-execution/resolve-tool.ts injectSessionState), read by the tool
 * through its accessor in tool-execution/internal-args.ts:
 *   session     — the trusted `_sessionId`; a tool with `pathArgs` gets it
 *                 whether or not it declares it, since the file-access gate
 *                 resolved its paths with that session
 *   operation   — `_operationId`, the op the call runs in
 *   userMessage — `_userMessageId`, the user message the call answers
 *   lastTurn    — `_lastUserMessage` / `_lastAssistantMessage`, the exchange
 *                 before the call, for a tool that checks its task against it
 *   project     — the session's current project fills `project_id` when the
 *                 call names none
 *   cwd         — `_cwd`: an autopilot run anchors the call at its checkout;
 *                 for a tool that also runs a shell command (`shellCommand`),
 *                 an agent's worktree or the session's work root does too
 * A tool body that reads a stamp through its accessor must declare it, or the
 * stamp is never set and the read sees nothing (session-scoped-tools.test.ts
 * scans every registered body). `project` fills a model argument and has no
 * accessor to scan: absent means the call keeps the project it names.
 */
export type TrustedStamp = "session" | "operation" | "userMessage" | "lastTurn" | "project" | "cwd";

/**
 * How a tool whose risk tier is too coarse to call it committing by name is
 * judged per call (committing-tool-check.ts): a replay would double its effect.
 *   kernel-write  — when the kernel action read off the call (ariAction) is a
 *                   write verb; arguments that did not parse count as a write
 *   path-write    — when the call opens a path for other than a read, or names
 *                   an action its path specs do not know
 *   commit-button — when it clicks a commit-shaped control (send, pay, delete…)
 */
export type CommittingSpec = "kernel-write" | "path-write" | "commit-button";

/** The Settings → Security kill-switch that turns a tool off. `enableShell` is
 *  never declared: it is read off the `shell` capability. */
export type ToolKillSwitch = "enableHttp" | "enableBrowser" | "enableComputerControl";

/** A surface a tool is kept off, with why: the MCP bridge the chat supervisor
 *  runs as (hidden from its list, refused on call) or an IDE session's schema. */
export type ToolSurface = "mcp" | "ide";

/** What an op was mostly doing, by the tools it used (tool-tracker.ts): the
 *  first category in this order with a tool used wins. `general` is no tool. */
export const OP_CATEGORIES = ["browser", "computer", "coding", "connector", "research"] as const;
export type OpCategory = (typeof OP_CATEGORIES)[number] | "general";
export const isOpCategory = (value: unknown): value is OpCategory =>
  value === "general" || (OP_CATEGORIES as readonly unknown[]).includes(value);

/** How the loop reads a call (agent-guards/, canonical-loop/):
 *   discovery  — a read-only lookup an agent spins on when it cannot find
 *                something (loop-discovery.ts); must be risk safe/network-read
 *   searchKey  — the argument whose normalized value identifies "the same
 *                search", so a re-run with another scope still counts as one
 *                and a redundant re-search is caught (loop-discovery.ts)
 *   mechanical — file mechanics whose result a model consumes without
 *                deliberation; an adapter may down-shift effort (step-effort.ts)
 *   silent     — its whole effect is a UI side effect with nothing to read
 *                back, so a narrated turn needs no wrap-up (silent-tool-check.ts)
 *   spinProne  — a real side effect that can be repeated turn after turn against
 *                a goal it cannot reach (mid-turn-stale.ts) */
export interface LoopFacts {
  discovery?: true;
  searchKey?: string;
  mechanical?: true;
  silent?: true;
  spinProne?: true;
}

/** One concrete tool's row. Every fact a gate needs about the tool lives here,
 *  so a new tool answers each question once, and the type will not build
 *  without the answers. */
export type ToolPolicyRow = ToolPolicyRowFacts & ToolSelectionFacts & RiskFacts & KernelFacts;

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
  /** The tool takes `secret_env` (vault values handed to its process as
   *  environment variables, tools/shell-secret-env.ts): the `use_secret` card
   *  and the outbound-secret recovery cover exactly these tools. */
  secretEnv?: true;
  /** What the result carries, when masking or taint must know (OutputKind). */
  output?: OutputKind;
  /** A successful result puts text authored off this computer in front of the
   *  model (a fetched page, a search result, mail, a folder name a server chose)
   *  — untrusted content that blocks the turn from auto-promoting memory. */
  externalContent?: true;
  /** Where a send delivers (DestinationSpec). A tool that sends with none is
   *  sending to an unknown destination: asked about, never waved through. */
  destination?: readonly DestinationSpec[];
  /** Call contexts the tool is refused in, each with why (the security layer
   *  and its rule pack read it): a scheduled job gets no browser. */
  deniedIn?: Partial<Record<CallContext, string>>;
  /** An "always allow" covers every later call, not just calls with the same
   *  arguments: only for a tool that edits LAX's own bookkeeping (the task
   *  list, the sidebar) and can reach no file, program, network or person. */
  wholeToolGrant?: true;
  /** A tool that reads unless one argument says otherwise: sql_query is a
   *  read unless `readonly` is false. Plan mode reads it (isReadOnlyCall). */
  readOnlyUnless?: { arg: string; value: unknown };
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
  // The facts below say what each absence means. "Required" ones are enforced
  // by the test named; the others default to the safe or neutral reading.

  /** The run state the dispatcher stamps into the call (TrustedStamp).
   *  REQUIRED for every stamp the tool's body reads (session-scoped-tools.test.ts);
   *  a tool with pathArgs gets `session` without declaring it. */
  reads?: readonly TrustedStamp[];
  /** Arguments of an egress tool that address or steer it on this machine and
   *  carry nothing anywhere (which action, which element, where the pointer
   *  goes): the outbound scans skip them, so a click reads as carrying nothing.
   *  Absent: every argument is payload (fails closed). Each must be a parameter
   *  of an egress tool (egress-payload.test.ts). */
  localArgs?: readonly string[];
  /** A control or terminal tool whose result is a few bytes (ask_user, task
   *  bookkeeping, process control, a status readout, delivering a finished
   *  artifact): refusing it under heap pressure frees nothing and can strand
   *  the turn, so the heap guard never does. Absent: refused like any call.
   *  Never a sensitive read or external content (heap-guard.test.ts). */
  runControl?: true;
  /** See CommittingSpec. Absent: committing by risk tier, the conservative
   *  reading. Each spec needs the row facts it reads (committing-tool-check.test.ts). */
  committing?: CommittingSpec;
  /** See ToolKillSwitch. REQUIRED on a tool named `browser*` or delivering to
   *  the browser page (enableBrowser), on one sending an arbitrary request (an
   *  `allowlisted` site destination: enableHttp) and on one driving the
   *  foreground app (enableComputerControl) — kill-switch-gates.test.ts. */
  killSwitch?: ToolKillSwitch;
  /** Where the tool reaches that no other fact on the row says, for strict
   *  local-only mode: `indirect-network` (a builder's installs, an update
   *  download, a manifest the proxy serves later, a subprocess outside the
   *  egress guard) is blocked; `local-device` (adb to a plugged-in phone) lets
   *  a shell tool through. Absent: judged by the row's other facts; a shell
   *  tool without `local-device` is blocked (fails closed). */
  reach?: { kind: "indirect-network" | "local-device"; why: string };
  /** See LoopFacts. Absent: no loop reading. A discovery tool is read-only, a
   *  mechanical one is a file tool, a searchKey is a declared parameter
   *  (loop-detection.test.ts, step-effort.test.ts, tool-registration-completeness.test.ts). */
  loop?: LoopFacts;
  /** Writes the agent's memory and returns nothing the model needs to read
   *  back: silent for the wrap-up question, and the agent's own bookkeeping
   *  rather than work on the user's request for the termination question
   *  (turn-loop/tool-failure-summary.ts). One fact, two decisions, by design.
   *  Absent: neither. Only a mutation tool (test/tool-failure-summary.test.ts). */
  memoryWrite?: true;
  /** See OpCategory. Absent: the tool says nothing about what the op was doing. */
  category?: Exclude<OpCategory, "general">;
  /** Surfaces the tool is kept off (ToolSurface), each with why. Absent: shown. */
  hiddenFrom?: Partial<Record<ToolSurface, string>>;
  /** The non-HTTP wire this tool carries for an integration: the tools that
   *  declare a transport, in table order, are that integration's whole
   *  interface (integrations/types.ts transportTools). Absent: not one of them. */
  transport?: Exclude<IntegrationTransport, "http">;
  /** Whether the tool ships something to a place other people consume
   *  (publish-operation.ts): the kind it publishes, or why a publish-shaped
   *  name ships nothing. REQUIRED on a tool named deploy/publish/release/push
   *  (publish-operation.test.ts); absent elsewhere: a shell command it runs is
   *  still read for publishes. */
  publish?: { kind: PublishKind } | { nothing: string };
  /** The usage steer the system prompt's "Tool Best Practices" section carries
   *  for this tool (tools/tool-prompt-builder.ts applyPrompts). Absent: none.
   *  Only on a tool in allTools, the set it is applied to
   *  (tool-registration-completeness.test.ts). */
  prompt?: string;
  /** Tools that must ship whenever this one does, because its own result text
   *  promises them (delete_file offers restore_file): the tier cap keeps them
   *  (tools/tool-companions.ts). Absent: none. Each is a registered tool
   *  (tool-registration-completeness.test.ts). */
  companions?: readonly string[];
}

/** A glob family ("memory_*") or the global "*" cap: a shared rule or rate
 *  limit, never a tool's facts. */
export type GlobPolicyEntry = Pick<ToolPolicyRowFacts, "rules" | "rateLimit"> & {
  [K in Exclude<keyof ToolPolicyRowFacts, "rules" | "rateLimit"> | keyof ToolSelectionFacts | "kernel" | "risk" | "undo" | "ariAction"]?: undefined;
};

export type ToolPolicyEntry = ToolPolicyRow | GlobPolicyEntry;
