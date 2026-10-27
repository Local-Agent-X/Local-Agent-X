// Canonical: the ONE per-family mapping from a create-class tool call to the
// resolved output path it will write. Two importers, one mapping:
// run-sandboxed.ts (task-artifact pre-stat) and audit-tool-call.ts
// (provenance recording) — extend it HERE, never fork a second
// tool→target-key table.

import { isAbsolute, resolve } from "node:path";
import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { declaredPaths, pathSpecsForCall, TOOL_PATH_ARGS } from "../tool-registry.js";
import { commandPositions } from "../security/layer/shell-command-positions.js";
import { enterPrelude } from "./shell-prelude.js";
import { chartOutPath } from "../tools/chart-tools.js";
import { addSlideOutPath } from "../tools/presentation-tools.js";

// Create-class tools — a SUCCESSFUL call means "a persistent file now exists
// at a caller-named path": every tool whose policy row declares a `write`
// path spec. Cheap membership gate: every other tool skips the task-artifact
// pre-stat entirely (that phase is on EVERY tool call). Membership is
// (tool, action)-conditional in createTargetPath below, by the same specs.
export const CREATE_CLASS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_PATH_ARGS).filter(([, specs]) => specs.some((spec) => spec.action === "write")).map(([name]) => name),
);

// The resolved output path a create-class call will write, or null when this
// (tool, action, args) combination creates nothing (e.g. spreadsheet read):
// the path the call's `write` spec names (the office families' specs are
// action-scoped, so a read action names none).
// PARITY RULE: resolve each tool's path EXACTLY as that tool's execute does —
// with sessionIdOf(args), the session the resolve phase stamps on every
// path-gated tool, so a registered session work root (auto-build chunk
// workers) anchors relative paths here as it does in the tool. A sessionless
// resolve enrolled a never-created workspace spelling and missed the real
// artifact. Two tools derive their output from the named path rather than
// writing it: create_chart (".png" appended) and presentation add_slide
// (`_slide_N.pptx` beside the original) — their exported derivations are the
// SAME functions the execute bodies call, so pre-stat and write land on one
// path. A presentation `edit` names no new file and creates nothing.
export function createTargetPath(toolName: string, args: Record<string, unknown>): string | null {
  const action = typeof args.action === "string" ? args.action : "";
  const sessionId = sessionIdOf(args);
  if (toolName === "create_chart") {
    return typeof args.file_path === "string" && args.file_path ? chartOutPath(args.file_path, sessionId) : null;
  }
  if (toolName === "presentation") {
    if (action === "edit") return null;
    if (action === "add_slide") {
      if (typeof args.file_path !== "string" || !args.file_path) return null;
      try { return addSlideOutPath(resolveAgentPath(args.file_path, sessionId), args.position); } catch { return null; }
    }
  }
  const spec = pathSpecsForCall(toolName, args).find((s) => s.action === "write");
  const raw = spec ? (declaredPaths(args, spec) ?? [])[0] : undefined;
  if (typeof raw !== "string" || !raw) return null;
  try { return resolveAgentPath(raw, sessionId); } catch { return null; }
}

// Only writes that TRUNCATE: what the file holds afterwards is this command's
// output. An append (`>>`) or a `touch` keeps whatever an earlier step of the
// line put at that path, which may be the user's bytes.
const WRITE_REDIRECTS: ReadonlySet<string> = new Set([">", ">|", "&>"]);
const CD_BINS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir", "set-location", "sl"]);
// Commands that only read, print or remove the paths they are given: naming
// the file cannot put anyone's bytes in it. Their own redirections are read
// above. A remove before the write leaves the write's bytes; one after leaves
// no file to enroll.
const PUTS_NO_BYTES_BINS: ReadonlySet<string> = new Set([
  "cat", "head", "tail", "less", "more", "wc", "grep", "egrep", "fgrep", "ls", "stat", "file",
  "md5sum", "sha1sum", "sha256sum", "test", "[", "echo", "printf", "rm", "unlink",
]);
const UNPLACEABLE = /[$`*?~{}]/;

/**
 * The files a shell command can create, resolved: its truncating
 * output-redirection targets (`> setup.log`, `&> build.log`, `>&out`) and the
 * operands of a flag-free `tee`. The caller enrolls only those that did not
 * exist before the command ran and do after it succeeded — the shell
 * counterpart of the pre-stat above, so a script's own log is the agent's on
 * every OS, not only where a birth time proves it new (unnamed-delete-gate.ts).
 *
 * A target that is also a word of any other command in the line is left out,
 * since that command may act on the path too (`mv users.csv new.csv && cat
 * new.csv > new.csv`), unless the command only reads or prints it (`cat`,
 * `tail`, `grep`, `rm`, …: TB2 qemu-alpine-ssh's `… > console.log; cat
 * console.log`). Relative targets resolve where the shell runs: `cwd`, or the
 * folder a leading `cd` enters (shell-prelude.ts; TB2 extract-elf's `cd /app &&
 * rm -f out.json && node extract.js > out.json`), and are left out after any
 * other `cd`, which this cannot follow; an expansion, glob, brace
 * or `~` is left out too. A file a program opens itself (`python gen.py`
 * writing out.csv) is not seen.
 */
export function shellCreateTargets(command: string, cwd: string): string[] {
  const entered = enterPrelude(command, cwd);
  if (entered) ({ command, cwd } = entered);
  const { positions } = commandPositions(command);
  const cdSeen = positions.some((p) => CD_BINS.has(p.bin));
  const targets: string[] = [];
  const otherWords = new Set<string>();
  for (const p of positions) {
    for (const r of p.redirections) {
      if (WRITE_REDIRECTS.has(r.op) || (r.op === ">&" && !/^(?:\d+|-)?$/.test(r.target))) targets.push(r.target);
    }
    const operands = p.words.slice(p.at + 1);
    const creates = p.bin === "tee" && operands.every((w) => !w.startsWith("-"));
    if (creates) targets.push(...operands);
    if (PUTS_NO_BYTES_BINS.has(p.bin)) continue;
    for (const w of creates ? p.words.slice(0, p.at + 1) : p.words) otherWords.add(w);
  }
  const out: string[] = [];
  for (const t of targets) {
    if (!t || UNPLACEABLE.test(t) || otherWords.has(t) || t.startsWith("/dev/")) continue;
    if (!isAbsolute(t) && cdSeen) continue;
    const abs = resolve(cwd, t);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}
