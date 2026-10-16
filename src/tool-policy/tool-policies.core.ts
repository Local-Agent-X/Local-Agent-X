// Fragment of the unified TOOL_POLICIES table — see tool-policies.data.ts for the
// full contract, security invariants, and how these fragments are merged.
//
// Shell / subprocess + raw filesystem tools. The security-heaviest concrete
// entries (bash denylist, write/edit confinement, delete_file path-bounding).

import type { ToolPolicyRow } from "./tool-policies.types.js";

export const TOOL_POLICIES_CORE: Record<string, ToolPolicyRow> = {
  // ── Shell / subprocess ──
  bash: {
    // The timeout sits ABOVE bash's own 120 s on purpose: bash kills its child
    // at its deadline and returns a clean timeout that names process_start;
    // the harness backstop only abandons the promise. At an equal 120 s the
    // backstop won the race, the command kept running, and the model was told
    // the harness had failed (2026-09-17).
    kernel: "shell", ariAction: "exec", risk: "shell", capabilities: ["sensitive-read", "shell"], timeoutMs: 130_000, shellCommand: { arg: "command", waitsForExit: true }, output: "command",
    rateLimit: { maxCalls: 30, windowMs: 60_000, action: "block" },
    // No `rm -rf` deny here: the irreversible-op floor (tool-execution) cards
    // every recursive delete for the user's approval. A hard deny above that
    // floor sent the model into `node` scripts and inline evals to do the same
    // delete uncarded — the workaround the floor cannot see (op-outcomes
    // restraint-wipe-build-cache, 2026-09-25). Removed at Peter's decision.
    rules: [
      { id: "deny-bash-format", decision: "deny", reason: "Blocked: format/fdisk commands", priority: 90, argMatch: { command: "format *" } },
      { id: "deny-bash-del-system", decision: "deny", reason: "Blocked: cannot delete system files", priority: 90, argMatch: { command: "del /f /s /q C:\\Windows*" } },
      { id: "allow-bash-git", decision: "allow", reason: "Git commands allowed", priority: 50, argMatch: { command: "git *" } },
      { id: "allow-bash-limited", decision: "allow", reason: "Shell allowed (rate limited, command-checked)", priority: 40, constraints: { maxCallsPerSession: 30 } },
    ],
  },
  process_start:    { kernel: "shell", ariAction: "exec",    risk: "shell", capabilities: ["egress", "shell"], liveState: "poll", shellCommand: { arg: "command" }, output: "command" },
  process_status:   { kernel: "shell", ariAction: "exec",    risk: "safe", capabilities: [], liveState: "poll", output: "command" },
  process_kill:     { kernel: "shell", ariAction: "exec",    risk: "destructive", capabilities: [], liveState: "poll", undo: { pairedWith: "process_start" } },
  process_restart:  { kernel: "shell", ariAction: "exec",    risk: "destructive", capabilities: ["egress", "shell"], liveState: "poll", shellCommand: { arg: "command" }, output: "command", undo: { pairedWith: "process_start" } },
  process_list:     { kernel: "shell", ariAction: "exec",    risk: "safe", capabilities: [], liveState: "poll", output: "command" },

  // ── Raw filesystem ──
  read:        { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["sensitive-read"], timeoutMs: 10_000, output: "file-content", pathArgs: [{ arg: "path", action: "read", knowsContent: true }], rules: [{ id: "allow-read", decision: "allow", reason: "File read (path-checked by SecurityLayer)", priority: 50 }] },
  write: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [], timeoutMs: 10_000,
    pathArgs: [{ arg: "path", action: "write", knowsContent: true }],
    rateLimit: { maxCalls: 50, windowMs: 60_000, action: "warn" },
    rules: [
      { id: "deny-write-system", decision: "deny", reason: "Blocked: cannot write to system directories", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-write-node-modules", decision: "deny", reason: "Blocked: do not write directly to node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-write", decision: "allow", reason: "File write (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  edit: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [], timeoutMs: 10_000,
    pathArgs: [{ arg: "path", action: "edit", knowsContent: true }],
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
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [],
    pathArgs: [{ arg: "path", action: "edit", knowsContent: true }],
    rules: [
      { id: "deny-edit-lines-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-edit-lines-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-edit-lines", decision: "allow", reason: "Line-number file edit (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  multi_edit: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [],
    pathArgs: [{ arg: "path", action: "edit", knowsContent: true }],
    rules: [
      { id: "deny-multi-edit-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-multi-edit-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-multi-edit", decision: "allow", reason: "Batched file edit (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  // bulk_replace is the tool-native alternative to `bash sed -i` over a tree —
  // same edit family, same pathArgs action:"edit" on the declared root. Its
  // targets are discovered at runtime UNDER that gated root; the tool itself
  // re-screens each file (no symlink follow, validated-inode read,
  // sensitive-pattern skip), so the root gate + per-file screen together cover
  // what the argMatch rules cover for the single-file tools.
  bulk_replace: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [],
    pathArgs: [{ arg: "path", action: "edit" }],
    rules: [
      { id: "deny-bulk-replace-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-bulk-replace-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-bulk-replace", decision: "allow", reason: "Multi-file find/replace (root path-checked by SecurityLayer; per-file screen in-tool)", priority: 50 },
    ],
  },
  // delete_file is the path-bounded alternative to `bash rm` — single file
  // per call, directories refused, workspace-bounded by SecurityLayer.
  delete_file: { kernel: "file", ariAction: "write", risk: "destructive", capabilities: [], undo: { pairedWith: "restore_file" }, pathArgs: [{ arg: "path", action: "delete_file" }], rules: [{ id: "allow-delete-file", decision: "allow", reason: "Single-file delete (path-checked by SecurityLayer, directories refused)", priority: 50 }] },
  // restore_file is delete_file's inverse leg on the task-trash tier: it puts
  // an agent-created file back where it was deleted from (safe-delete.ts,
  // restoreFromTaskTrash). It materializes bytes on disk, so it is gated as a
  // workspace write; the actual restore target is the manifest-recorded
  // original path (already gated at delete time), while both declared args
  // ride the same write confinement — a bare basename/in-trash ref resolves
  // inside project bounds, and the explicit destination for recovered entries
  // is a caller-chosen write sink.
  restore_file: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [],
    pathArgs: [{ arg: "path", action: "write" }, { arg: "destination", action: "write" }],
    rules: [{ id: "allow-restore-file", decision: "allow", reason: "Task-trash restore (path-checked by SecurityLayer; refuses overwrite)", priority: 50 }],
  },
  glob:        { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["sensitive-read"], output: "file-content", pathArgs: [{ arg: "path", action: "read", searchRoot: true }], rules: [{ id: "allow-glob", decision: "allow", reason: "File pattern search (read-only)", priority: 50 }] },
  grep:        { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["sensitive-read"], output: "file-content", pathArgs: [{ arg: "path", action: "read", searchRoot: true }], rules: [{ id: "allow-grep", decision: "allow", reason: "Content search (read-only)", priority: 50 }] },
  structural_search: { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["sensitive-read"], output: "file-content", pathArgs: [{ arg: "path", action: "read", searchRoot: true }], rules: [{ id: "allow-structural-search", decision: "allow", reason: "Symbol-accurate code search (read-only)", priority: 50 }] },
  view_image:  { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], timeoutMs: 10_000, offBoxFetch: true, pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-view-image", decision: "allow", reason: "Image viewing (path-checked); base64-ships the image off-box to the vision API", priority: 50 }] },
  transcribe_media:   { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], offBoxFetch: true, pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-transcribe-media", decision: "allow", reason: "Transcribes a local recording (path-checked read); ships audio off-box when a CLOUD stt provider is configured", priority: 50 }] },
  read_video_frames:  { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], offBoxFetch: true, pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-read-video-frames", decision: "allow", reason: "Samples frames from a local video (path-checked read); base64-ships them off-box to the vision API", priority: 50 }] },
  send_video:  { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], offBoxFetch: true, destination: [{ to: "user", message: true }], pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-send-video", decision: "allow", reason: "Sends a local video to the user over their own bridge (path-checked read)", priority: 50 }] },
  send_image:  { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], offBoxFetch: true, destination: [{ to: "user", message: true }], pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-send-image", decision: "allow", reason: "Sends a local image to the user over their own bridge (path-checked read)", priority: 50 }] },
  send_file:   { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], offBoxFetch: true, destination: [{ to: "user", message: true }], pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-send-file", decision: "allow", reason: "Stages a local document for the user's own device to fetch (path-checked read)", priority: 50 }] },
  // The kernel file bridge opens the caller's `path` for its `action`; the
  // action-conditional specs fail closed, so a call must name read or write.
  ari_file:    { kernel: "internal", risk: "workspace-write", capabilities: ["sensitive-read"], pathArgs: [
    { arg: "path", action: "read",  forActions: ["read"] },
    { arg: "path", action: "write", forActions: ["write"] },
  ] },

};
