// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Shell / subprocess + raw filesystem tools. The security-heaviest concrete
// entries (bash denylist, write/edit confinement, delete_file path-bounding).

import type { ToolPolicyEntry } from "./tool-policies.types.js";

export const TOOL_POLICIES_CORE: Record<string, ToolPolicyEntry> = {
  // ── Shell / subprocess ──
  bash: {
    kernel: "shell", risk: "shell",
    rateLimit: { maxCalls: 30, windowMs: 60_000, action: "block" },
    rules: [
      { id: "deny-bash-rm-rf", decision: "deny", reason: "Blocked: rm -rf is too dangerous for automated execution", priority: 90, argMatch: { command: "rm -rf *" } },
      { id: "deny-bash-format", decision: "deny", reason: "Blocked: format/fdisk commands", priority: 90, argMatch: { command: "format *" } },
      { id: "deny-bash-del-system", decision: "deny", reason: "Blocked: cannot delete system files", priority: 90, argMatch: { command: "del /f /s /q C:\\Windows*" } },
      { id: "allow-bash-git", decision: "allow", reason: "Git commands allowed", priority: 50, argMatch: { command: "git *" } },
      { id: "allow-bash-limited", decision: "allow", reason: "Shell allowed (rate limited, command-checked)", priority: 40, constraints: { maxCallsPerSession: 30 } },
    ],
  },
  ari_shell:        { kernel: "internal", risk: "shell" },
  process_start:    { kernel: "shell",    risk: "shell" },
  process_status:   { kernel: "shell",    risk: "safe" },
  process_kill:     { kernel: "shell",    risk: "destructive" },
  process_restart:  { kernel: "shell",    risk: "destructive" },
  process_list:     { kernel: "shell",    risk: "safe" },

  // ── Raw filesystem ──
  read:        { kernel: "file", risk: "safe", pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-read", decision: "allow", reason: "File read (path-checked by SecurityLayer)", priority: 50 }] },
  write: {
    kernel: "file", risk: "workspace-write",
    pathArgs: [{ arg: "path", action: "write" }],
    rateLimit: { maxCalls: 50, windowMs: 60_000, action: "warn" },
    rules: [
      { id: "deny-write-system", decision: "deny", reason: "Blocked: cannot write to system directories", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-write-node-modules", decision: "deny", reason: "Blocked: do not write directly to node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-write", decision: "allow", reason: "File write (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  edit: {
    kernel: "file", risk: "workspace-write",
    pathArgs: [{ arg: "path", action: "edit" }],
    rules: [
      { id: "deny-edit-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-edit-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-edit", decision: "allow", reason: "File edit (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  // edit_lines / multi_edit are edit synonyms (line-range edit; batched atomic
  // edits). They MUST carry the same pathArgs action:"edit" so SecurityLayer
  // applies workspace-confinement — without it they'd be denied by default-deny,
  // and any naive "just allow them" rule lacking pathArgs would write unbounded.
  edit_lines: {
    kernel: "file", risk: "workspace-write",
    pathArgs: [{ arg: "path", action: "edit" }],
    rules: [
      { id: "deny-edit-lines-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-edit-lines-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-edit-lines", decision: "allow", reason: "Line-number file edit (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  multi_edit: {
    kernel: "file", risk: "workspace-write",
    pathArgs: [{ arg: "path", action: "edit" }],
    rules: [
      { id: "deny-multi-edit-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-multi-edit-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-multi-edit", decision: "allow", reason: "Batched file edit (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  // delete_file is the path-bounded alternative to `bash rm` — single file
  // per call, directories refused, workspace-bounded by SecurityLayer.
  delete_file: { kernel: "file", risk: "destructive", pathArgs: [{ arg: "path", action: "delete_file" }], rules: [{ id: "allow-delete-file", decision: "allow", reason: "Single-file delete (path-checked by SecurityLayer, directories refused)", priority: 50 }] },
  glob:        { kernel: "file", risk: "safe", pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-glob", decision: "allow", reason: "File pattern search (read-only)", priority: 50 }] },
  grep:        { kernel: "file", risk: "safe", pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-grep", decision: "allow", reason: "Content search (read-only)", priority: 50 }] },
  view_image:  { kernel: "file", risk: "safe", pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-view-image", decision: "allow", reason: "Image viewing (path-checked)", priority: 50 }] },
  send_video:  { kernel: "file", risk: "safe", offBoxFetch: true, pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-send-video", decision: "allow", reason: "Sends a local video to the user over their own bridge (path-checked read)", priority: 50 }] },
  ari_file:    { kernel: "internal", risk: "workspace-write" },

};
