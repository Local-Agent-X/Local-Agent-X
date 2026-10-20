// Tool taxonomy types + the derived TOOLS projection.
//
// The DATA lives in the unified policy table (src/tool-policy/tool-policies.data.ts),
// which joins each tool's kernel class, risk tier, explicit policy rule(s), and
// rate-limit cap in ONE entry. This module owns the taxonomy TYPES and projects
// the table's concrete-tool entries into TOOLS for the kernel/autonomy consumers:
//
//   kernel:  what defense pipeline runs at dispatch? (ari-kernel/evaluate.ts)
//   risk:    what does the user lose if this fires without approval?
//            (consumed by autonomy gate + approval-manager)
//
// TOOL_CLASS_MAP (ari-kernel/tool-class-map.ts) and TOOL_RISK (autonomy/risk.ts)
// remain the derived projections downstream consumers import. Adding a tool is a
// single edit to the table; a kernel tool missing a policy rule is caught by
// auditPolicyCoverage at boot (and the orphan test), not papered over by a
// silent risk-tier fallback.

import { deriveTools, derivePathArgs, TOOL_POLICIES } from "./tool-policy/tool-policies.js";
import type { PathArgSpec } from "./tool-policy/tool-policies.data.js";
import type {
  CommittingSpec, DeclaredCapability, DestinationSpec, LoopFacts, OpCategory, OutputKind, ToolKillSwitch, ToolPolicyRow,
  ToolSurface, TrustedStamp,
} from "./tool-policy/tool-policies.types.js";
import type { ToolTag } from "./tool-policy/tool-tags.js";
import { getActivePluginToolMetadata } from "./plugin-system/tool-metadata.js";
import type { CallContext } from "./tool-execution/context.js";
export type { PathArgSpec } from "./tool-policy/tool-policies.data.js";

export type KernelClass =
  | "file"
  | "http"
  | "shell"
  | "database"
  | "retrieval"
  | "secret-vault"
  | "internal";

export type ToolRisk =
  | "safe"             // read-only local / pure compute / catalog lookup
  | "workspace-write"  // creates or mutates files in workspace/ or LAX state
  | "network-read"     // outbound read-only (GET fetch, search, scrape)
  | "network-write"    // outbound state-changing (POST/PUT/DELETE)
  | "shell"            // subprocess spawn / arbitrary command execution
  | "destructive"      // irreversible delete / overwrite / cancel / uninstall
  | "money"            // bills a real-world account (payments, paid APIs)
  | "external-comms"   // sends a message a third party will see
  | "secrets"          // touches the credential vault — read, write, or fill-from
  | "publish";         // ships code or artifacts others consume — git push, deploy, package publish, release

export interface ToolEntry {
  kernel: KernelClass;
  risk: ToolRisk;
}

// Kernel classes that gate at dispatch (taint analysis, capability check,
// audit log). "internal" runs entirely inside LAX state — dispatch skips
// the kernel. See ari-kernel/tool-class-map.ts:shouldGateInKernel.
export const GATED_KERNEL_CLASSES: ReadonlySet<KernelClass> = new Set<KernelClass>([
  "file", "http", "shell", "database", "retrieval", "secret-vault",
]);

/** Concrete-tool taxonomy, projected from the unified policy table. */
export const TOOLS: Record<string, ToolEntry> = deriveTools();

// Tool → caller-supplied file path arg(s). SecurityLayer routes each through
// evaluateFileAccess so the file-access mode confines EVERY file sink — not just
// the four raw fs tools. A path-opening tool absent here bypasses confinement.
export const TOOL_PATH_ARGS: Record<string, PathArgSpec[]> = derivePathArgs();

// ── Capability classes (THE single source of truth for I/O-sink gating) ──
//
// Security gates must NOT key on literal tool NAMES: the ari_* bridge tools and
// other synonyms (email_send, browser, clipboard_write, process_start, ari_file,
// email_read, memory_search) are the SAME I/O sinks under names no gate
// recognizes — so name-keyed gates let them bypass egress / sensitive-read /
// worktree enforcement. Every gate keys on class membership instead, and the
// membership is the tool's own policy row: egress, sensitive-read and shell are
// declared there (`capabilities`), and workspace-write is read off the paths
// the row says a call writes, edits or deletes (`pathArgs`). A tool joins a
// class by saying what it does, in the one place a new tool is added.
export type CapabilityClass = DeclaredCapability | "workspace-write";

function declaredMembers(cls: DeclaredCapability): ReadonlySet<string> {
  return new Set(Object.entries(TOOL_POLICIES).filter(([, row]) => row.capabilities?.includes(cls)).map(([name]) => name));
}

const DECLARED_SETS: Record<DeclaredCapability, ReadonlySet<string>> = {
  "egress": declaredMembers("egress"),
  "sensitive-read": declaredMembers("sensitive-read"),
  "shell": declaredMembers("shell"),
};

/** A path spec that writes, edits or deletes at its path. */
const writesAt = (spec: PathArgSpec): boolean => spec.action !== "read";

/**
 * The path specs of `name` that a call opens: for a collapsed family whose specs
 * are action-scoped (`forActions`), only those naming the call's action. Without
 * `args`, every spec — what the tool opens on SOME call. (SecurityLayer also
 * refuses a call whose action no scoped spec names; that is its check, not this.)
 */
export function pathSpecsForCall(name: string, args?: Record<string, unknown>): readonly PathArgSpec[] {
  const specs = TOOL_PATH_ARGS[name] ?? [];
  if (!args) return specs;
  const action = String(args.action ?? "");
  return specs.filter((spec) => !spec.forActions || spec.forActions.includes(action));
}

/** The paths a declared path arg carries: one string, a real array of
 *  strings, or (json) a JSON-array string. Returns null when an array holds a
 *  non-string element — the caller fails closed, since a value the gate cannot
 *  read as a path must not reach the tool as one. A json arg whose string is
 *  not a JSON array is gated as the one path it spells: generate_video treats
 *  a bare string as a single reference, so skipping it would skip the read. */
export function pathArgPaths(raw: unknown, json?: boolean): string[] | null {
  if (Array.isArray(raw)) return raw.every((x): x is string => typeof x === "string") ? raw : null;
  if (typeof raw !== "string" || raw.length === 0) return [];
  if (!json) return [raw];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [raw];
  }
  return Array.isArray(parsed) ? pathArgPaths(parsed) : [raw];
}

/** Every path one PathArgSpec names in a call's args, or null when a value
 *  cannot be read as paths (fail closed). `each` specs read the path off every
 *  element of an array-of-objects arg (op_submit_batch.tasks[].context_files);
 *  an element that is not an object fails closed too. */
export function declaredPaths(args: Record<string, unknown>, spec: PathArgSpec): string[] | null {
  const raw = args[spec.arg];
  if (!spec.each) return pathArgPaths(raw, spec.json);
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const paths = pathArgPaths((item as Record<string, unknown>)[spec.each], spec.json);
    if (paths === null) return null;
    out.push(...paths);
  }
  return out;
}

/** The paths this call names, by what it does at each: reads, writes (create
 *  or edit), deletes. For the readers that report or track paths; a gate that
 *  must fail closed on an unreadable value reads declaredPaths itself. */
export function callPaths(name: string, args: Record<string, unknown>): { reads: string[]; writes: string[]; deletes: string[] } {
  const out = { reads: [] as string[], writes: [] as string[], deletes: [] as string[] };
  for (const spec of pathSpecsForCall(name, args)) {
    const into = spec.action === "read" ? out.reads : spec.action === "delete_file" ? out.deletes : out.writes;
    into.push(...(declaredPaths(args, spec) ?? []));
  }
  return out;
}

// Every member by class, name-level (a tool that writes on SOME call is a
// workspace-write member), for the consumers that list the class or describe it.
export const CAPABILITY_CLASS_MEMBERS: Record<CapabilityClass, readonly string[]> = {
  "egress": [...DECLARED_SETS.egress],
  "sensitive-read": [...DECLARED_SETS["sensitive-read"]],
  "shell": [...DECLARED_SETS.shell],
  "workspace-write": Object.keys(TOOL_PATH_ARGS).filter((name) => TOOL_PATH_ARGS[name].some(writesAt)),
};

/**
 * Does `name` belong to capability class `cls`? With the call's `args`, the
 * answer is for THIS call: a spreadsheet `read` writes nothing, its `write`
 * does. Without them, for any call the tool can make.
 */
export function hasCapability(name: string, cls: CapabilityClass, args?: Record<string, unknown>): boolean {
  if (getActivePluginToolMetadata(name)) return cls === "shell";
  if (cls === "workspace-write") {
    return pathSpecsForCall(name, args).some((spec) => writesAt(spec) && !(args && spec.whenGiven && args[spec.arg] === undefined));
  }
  return DECLARED_SETS[cls].has(name);
}

/** The shell command this call runs, read from the arg its row's shellCommand
 *  names; undefined for a tool that runs none, or a call that passed none (a
 *  restart reusing a tracked session's command). */
export function shellCommandOf(name: string, args: Record<string, unknown>): string | undefined {
  const arg = TOOL_POLICIES[name]?.shellCommand?.arg;
  const value = arg ? args[arg] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Does this tool's call return only once its shell command has exited, so
 *  what the command did is settled when the result arrives (bash)? */
export function waitsForShellCommand(name: string): boolean {
  return TOOL_POLICIES[name]?.shellCommand?.waitsForExit === true;
}

/** This tool's own policy row, or undefined for a name with none (a glob key,
 *  a runtime MCP server tool, a name from another system). */
export function policyRowOf(name: string): ToolPolicyRow | undefined {
  const row = TOOL_POLICIES[name];
  return row?.kernel !== undefined ? row : undefined;
}

/** What this tool's result carries, when masking or taint must know. */
export function outputOf(name: string): OutputKind | undefined {
  return TOOL_POLICIES[name]?.output;
}

/** The action the Ari kernel judges this call as; "exec" for a tool with no
 *  row (the kernel never sees an internal tool). A spec read off an argument
 *  resolves against the call: a POST or a browser click is a write verb. */
export function ariActionOf(name: string, args: Record<string, unknown>): string {
  const spec = TOOL_POLICIES[name]?.ariAction;
  if (spec === undefined) return "exec";
  if (typeof spec === "string") return spec;
  const value = String(args?.[spec.arg] ?? "").toLowerCase();
  const write = spec.writes.find((w) => w.toLowerCase() === value);
  return write ? (spec.as ?? write.toLowerCase()) : "get";
}

/** Why this tool is refused in `context`, or undefined when it is not. */
export function deniedInContext(name: string, context: CallContext): string | undefined {
  return TOOL_POLICIES[name]?.deniedIn?.[context];
}

/** Every tool with a context it is refused in, with those contexts. */
export const CONTEXT_DENIALS: ReadonlyArray<readonly [string, readonly CallContext[]]> = Object.entries(TOOL_POLICIES)
  .flatMap(([name, row]) => (row.deniedIn ? [[name, Object.keys(row.deniedIn) as CallContext[]] as const] : []));

/** Does an "always allow" of this tool cover every later call? */
export function wholeToolGrant(name: string): boolean {
  return TOOL_POLICIES[name]?.wholeToolGrant === true;
}

/** Every concrete tool whose row satisfies `fact`, in table order. */
export function toolsWhere(fact: (row: ToolPolicyRow) => boolean): string[] {
  return Object.entries(TOOL_POLICIES).flatMap(([name, row]) => (row.kernel !== undefined && fact(row) ? [name] : []));
}

/** Every concrete tool whose row carries any of `tags`, in table order. */
export function toolsTagged(...tags: readonly ToolTag[]): string[] {
  return toolsWhere((row) => row.tags.some((tag) => tags.includes(tag)));
}

/** Does the dispatcher stamp `stamp` into this tool's calls? The session is
 *  stamped on every tool with pathArgs as well: the gate resolved its paths
 *  with that session, so the tool must resolve them with the same one. */
export function readsStamp(name: string, stamp: TrustedStamp): boolean {
  const row = TOOL_POLICIES[name];
  return row?.reads?.includes(stamp) === true || (stamp === "session" && (row?.pathArgs?.length ?? 0) > 0);
}

/** Is this a shell command whose working directory the dispatcher supplies
 *  (an agent's worktree, a session's work root)? A tool that only opens
 *  paths has them rewritten instead. */
export function anchorsShellAtCwd(name: string): boolean {
  return readsStamp(name, "cwd") && TOOL_POLICIES[name]?.shellCommand !== undefined;
}

/** The arguments of this egress tool that steer it locally and carry nothing. */
export function localArgsOf(name: string): readonly string[] {
  return TOOL_POLICIES[name]?.localArgs ?? [];
}

/** Is this a control or terminal tool the heap guard never refuses? */
export function isRunControl(name: string): boolean {
  return TOOL_POLICIES[name]?.runControl === true;
}

/** How this tool's calls are judged committing, when not by its risk tier. */
export function committingSpecOf(name: string): CommittingSpec | undefined {
  return TOOL_POLICIES[name]?.committing;
}

/** The kill-switch that turns this tool off: its row's, or Shell Access for
 *  every shell-class tool (the process_* family spawns the same subprocess). */
export function killSwitchOf(name: string): ToolKillSwitch | "enableShell" | undefined {
  return TOOL_POLICIES[name]?.killSwitch ?? (hasCapability(name, "shell") ? "enableShell" : undefined);
}

/** Where this tool reaches that no other fact on its row says. */
export function reachOf(name: string): ToolPolicyRow["reach"] {
  return TOOL_POLICIES[name]?.reach;
}

/** How the loop reads this tool's calls; `{}` for a tool that says nothing. */
export function loopFactsOf(name: string): LoopFacts {
  return TOOL_POLICIES[name]?.loop ?? {};
}

/** Does this tool write the agent's memory with nothing to read back? */
export function isMemoryWrite(name: string): boolean {
  return TOOL_POLICIES[name]?.memoryWrite === true;
}

/** What an op using this tool was doing, when the tool says. */
export function categoryOf(name: string): Exclude<OpCategory, "general"> | undefined {
  return TOOL_POLICIES[name]?.category;
}

/** Why this tool is kept off `surface`, or undefined when it is shown there. */
export function hiddenFrom(name: string, surface: ToolSurface): string | undefined {
  return TOOL_POLICIES[name]?.hiddenFrom?.[surface];
}

/** Whether this tool ships something to others, as its row says. */
export function publishFactOf(name: string): ToolPolicyRow["publish"] {
  return TOOL_POLICIES[name]?.publish;
}

/** The usage steer the system prompt carries for this tool. */
export function promptOf(name: string): string | undefined {
  return TOOL_POLICIES[name]?.prompt;
}

/** The tools that must ship whenever this one does. */
export function companionsOf(name: string): readonly string[] {
  return TOOL_POLICIES[name]?.companions ?? [];
}

const KERNEL_READ_ACTIONS: ReadonlySet<string> = new Set(["get", "head", "options", "read", "query", "search", "exec"]);

/**
 * Does this call change nothing — plan mode's one question, read off the row:
 *   - a collapsed family (action-scoped path specs) is judged by the call's
 *     action: every path it opens is a read (document read, pdf extract_tables);
 *   - any other tool by its risk tier: `safe` or `network-read`, and then only
 *     a call that opens no non-read path, is not a shell, is judged a read by
 *     the kernel (a browser click is a post) and delivers nothing to anyone
 *     but the user (a recipient, a chat, somewhere the check cannot name). Its
 *     row's `destination` says who: a send to the user's own device
 *     (send_file) is part of planning;
 *   - `readOnlyUnless` names the one argument that turns a read into a write.
 * A tool with no row changes something until its row says otherwise.
 */
export function isReadOnlyCall(name: string, args: Record<string, unknown>): boolean {
  const row = policyRowOf(name);
  if (!row) return false;
  if (row.readOnlyUnless) return args[row.readOnlyUnless.arg] !== row.readOnlyUnless.value;
  const specs = pathSpecsForCall(name, args);
  if ((row.pathArgs ?? []).some((spec) => spec.forActions)) return specs.length > 0 && specs.every((spec) => spec.action === "read");
  if (row.risk !== "safe" && row.risk !== "network-read") return false;
  if (hasCapability(name, "shell") || specs.some(writesAt)) return false;
  if (!KERNEL_READ_ACTIONS.has(ariActionOf(name, args))) return false;
  const delivers = (destinationSpecsOf(name, args) ?? []).some((d) => d.to === "recipients" || d.to === "chat" || d.to === "unknown");
  return !delivers;
}

/** Where this call delivers, as its row declares it: the specs scoped to the
 *  call's action when any are, else the unscoped ones. undefined for a tool
 *  whose row declares no destination. */
export function destinationSpecsOf(name: string, args: Record<string, unknown>): readonly DestinationSpec[] | undefined {
  const specs = TOOL_POLICIES[name]?.destination;
  if (!specs) return undefined;
  const action = String(args.action ?? "");
  const scoped = specs.filter((s) => s.forActions?.includes(action));
  return scoped.length > 0 ? scoped : specs.filter((s) => !s.forActions);
}

/**
 * Build-time invariant: no single tool may be BOTH an egress sink AND a
 * sensitive-read sink. Such a tool could self-race within its own pipeline —
 * its egress check (policy phase) and its taint floor-set (sandbox phase) run
 * in one dispatch, so the floor it sets could never gate its own egress, and
 * the batcher's no-co-batch rule (which keeps the two classes in separate
 * batches) collapses to a no-op for a tool that is its own counterparty.
 * Keeping the two classes disjoint is what lets a sensitive read always taint
 * before any egress tool observes the floor.
 *
 * Throws on violation so the gap fails the build (and the boot path) instead of
 * silently re-opening the R4-09 race. Called at module load below and asserted
 * directly in capability-class-gates.test.ts.
 */
export function validateCapabilitySets(): void {
  const overlap = [...DECLARED_SETS.egress].filter((name) => DECLARED_SETS["sensitive-read"].has(name));
  if (overlap.length > 0) {
    throw new Error(
      `capability-set invariant violated: tool(s) are BOTH egress and sensitive-read ` +
      `(${overlap.join(", ")}) — a tool that is both could self-race its own egress gate ` +
      `against its own taint floor. Split the capability or re-scope the tool.`,
    );
  }
}

// Enforce the disjointness invariant at module load (build/boot time), so a
// future edit that makes a tool both classes fails fast rather than at runtime.
validateCapabilitySets();
