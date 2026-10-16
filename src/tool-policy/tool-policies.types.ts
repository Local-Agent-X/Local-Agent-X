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

/** One concrete tool's row. Every fact a gate needs about the tool lives here,
 *  so a new tool answers each question once, and the type will not build
 *  without the answers. */
export interface ToolPolicyRow {
  /** The kernel defense pipeline — feeds TOOLS / TOOL_CLASS_MAP. */
  kernel: KernelClass;
  /** What the user loses if it fires unapproved — feeds TOOL_RISK. */
  risk: ToolRisk;
  /** The sink classes this tool belongs to; `[]` when none. */
  capabilities: readonly DeclaredCapability[];
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
  pathArgs?: undefined;
  offBoxFetch?: undefined;
}

export type ToolPolicyEntry = ToolPolicyRow | GlobPolicyEntry;
