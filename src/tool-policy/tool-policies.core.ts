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
    kernel: "shell", ariAction: "exec", risk: "shell", capabilities: ["sensitive-read", "shell"], tags: ["shell"], essentialRank: 4, blurb: { say: "run `npm test` in the project", does: "Run a shell command." }, timeoutMs: 130_000, shellCommand: { arg: "command", waitsForExit: true }, secretEnv: true, output: "command",
    reads: ["cwd"], category: "coding",
    prompt: "Only use bash for shell commands. Never use it for file read/write/search — use dedicated tools. Probe for installed tools with targeted commands (command -v / where / Get-Command); never dump the environment (printenv/env/set) — secret-shaped output is redacted and wastes the call.",
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
  // The file-access gate judges process_start/_restart's cwd with the call's
  // session (kernel-class-policy.ts); the tool resolves it with the same one.
  process_start:    { kernel: "shell", ariAction: "exec",    risk: "shell", capabilities: ["egress", "shell"], tags: [], liveState: "poll", shellCommand: { arg: "command" }, secretEnv: true, output: "command", reads: ["session"] },
  process_status:   { kernel: "shell", ariAction: "exec",    risk: "safe", capabilities: [], tags: [], liveState: "poll", output: "command", runControl: true },
  process_kill:     { kernel: "shell", ariAction: "exec",    risk: "destructive", capabilities: [], tags: [], liveState: "poll", undo: { pairedWith: "process_start" }, runControl: true },
  process_restart:  { kernel: "shell", ariAction: "exec",    risk: "destructive", capabilities: ["egress", "shell"], tags: [], liveState: "poll", shellCommand: { arg: "command" }, secretEnv: true, output: "command", undo: { pairedWith: "process_start" }, reads: ["session"] },
  process_list:     { kernel: "shell", ariAction: "exec",    risk: "safe", capabilities: [], tags: [], liveState: "poll", output: "command", runControl: true },

  // ── Raw filesystem ──
  read: {
    kernel: "file", ariAction: "read", risk: "safe", capabilities: ["sensitive-read"], tags: ["file-read"], essentialRank: 1, blurb: { does: "Read a file's contents." }, timeoutMs: 10_000, output: "file-content", pathArgs: [{ arg: "path", action: "read", knowsContent: true }],
    loop: { discovery: true, mechanical: true },
    prompt: "Use read for files instead of bash cat/head/tail. Supports offset/limit for large files. When exploring code, pass include_imports:true to get the file's local imports in the same call instead of follow-up reads.",
    rules: [{ id: "allow-read", decision: "allow", reason: "File read (path-checked by SecurityLayer)", priority: 50 }],
  },
  write: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [], tags: ["file-write"], essentialRank: 2, blurb: { does: "Create or overwrite a file." }, timeoutMs: 10_000,
    pathArgs: [{ arg: "path", action: "write", knowsContent: true }],
    loop: { mechanical: true }, category: "coding",
    prompt: "Use write for new files instead of bash echo/heredoc. Read existing files before overwriting.",
    rateLimit: { maxCalls: 50, windowMs: 60_000, action: "warn" },
    rules: [
      { id: "deny-write-system", decision: "deny", reason: "Blocked: cannot write to system directories", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-write-node-modules", decision: "deny", reason: "Blocked: do not write directly to node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-write", decision: "allow", reason: "File write (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  edit: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [], tags: ["file-edit"], essentialRank: 3, blurb: { say: "edit index.html and change the title", does: "Make a targeted edit to a file." }, timeoutMs: 10_000,
    pathArgs: [{ arg: "path", action: "edit", knowsContent: true }],
    loop: { mechanical: true }, category: "coding",
    prompt: "Use edit for targeted find-and-replace instead of bash sed/awk. Read the file first.",
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
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [], tags: ["file-edit-variant"],
    pathArgs: [{ arg: "path", action: "edit", knowsContent: true }],
    loop: { mechanical: true }, category: "coding",
    rules: [
      { id: "deny-edit-lines-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-edit-lines-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-edit-lines", decision: "allow", reason: "Line-number file edit (path-checked by SecurityLayer)", priority: 50 },
    ],
  },
  multi_edit: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [], tags: ["file-edit-variant"],
    pathArgs: [{ arg: "path", action: "edit", knowsContent: true }],
    loop: { mechanical: true }, category: "coding",
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
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [], tags: ["file-edit-variant"],
    pathArgs: [{ arg: "path", action: "edit" }], category: "coding",
    rules: [
      { id: "deny-bulk-replace-system", decision: "deny", reason: "Blocked: cannot edit system files", priority: 90, argMatch: { path: "C:\\Windows*" } },
      { id: "deny-bulk-replace-node-modules", decision: "deny", reason: "Blocked: do not edit directly in node_modules", priority: 80, argMatch: { path: "*node_modules*" } },
      { id: "allow-bulk-replace", decision: "allow", reason: "Multi-file find/replace (root path-checked by SecurityLayer; per-file screen in-tool)", priority: 50 },
    ],
  },
  // delete_file is the path-bounded alternative to `bash rm` — single file
  // per call, directories refused, workspace-bounded by SecurityLayer. Its
  // result tells the user the file can be restored, so restore_file ships
  // wherever it does.
  delete_file: { kernel: "file", ariAction: "write", risk: "destructive", capabilities: [], tags: ["file-delete"], essentialRank: 10, blurb: { does: "Delete a file." }, undo: { pairedWith: "restore_file" }, companions: ["restore_file"], category: "coding", pathArgs: [{ arg: "path", action: "delete_file" }], rules: [{ id: "allow-delete-file", decision: "allow", reason: "Single-file delete (path-checked by SecurityLayer, directories refused)", priority: 50 }] },
  // restore_file is delete_file's inverse leg on the task-trash tier: it puts
  // an agent-created file back where it was deleted from (safe-delete.ts,
  // restoreFromTaskTrash). It materializes bytes on disk, so it is gated as a
  // workspace write; the actual restore target is the manifest-recorded
  // original path (already gated at delete time), while both declared args
  // ride the same write confinement — a bare basename/in-trash ref resolves
  // inside project bounds, and the explicit destination for recovered entries
  // is a caller-chosen write sink.
  restore_file: {
    kernel: "file", ariAction: "write", risk: "workspace-write", capabilities: [], tags: ["file-delete"], essentialRank: 11, category: "coding",
    pathArgs: [{ arg: "path", action: "write" }, { arg: "destination", action: "write" }],
    rules: [{ id: "allow-restore-file", decision: "allow", reason: "Task-trash restore (path-checked by SecurityLayer; refuses overwrite)", priority: 50 }],
  },
  glob: {
    kernel: "file", ariAction: "read", risk: "safe", capabilities: ["sensitive-read"], tags: ["file-search"], essentialRank: 19, blurb: { does: "Find files by name pattern." }, output: "file-content", pathArgs: [{ arg: "path", action: "read", searchRoot: true }],
    loop: { discovery: true, mechanical: true },
    prompt: "Use glob for finding files by name pattern. Faster than bash find/ls.",
    rules: [{ id: "allow-glob", decision: "allow", reason: "File pattern search (read-only)", priority: 50 }],
  },
  grep: {
    kernel: "file", ariAction: "read", risk: "safe", capabilities: ["sensitive-read"], tags: ["file-search"], essentialRank: 20, blurb: { does: "Search file contents." }, output: "file-content", pathArgs: [{ arg: "path", action: "read", searchRoot: true }],
    loop: { discovery: true, mechanical: true, searchKey: "pattern" },
    prompt: "ALWAYS use grep for content search. Never bash grep/rg. Supports regex, type filtering, 3 output modes. content mode includes surrounding context per hit by default — follow-up reads of hit files are usually unnecessary.",
    rules: [{ id: "allow-grep", decision: "allow", reason: "Content search (read-only)", priority: 50 }],
  },
  structural_search: { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["sensitive-read"], tags: ["file-search"], output: "file-content", pathArgs: [{ arg: "path", action: "read", searchRoot: true }], loop: { mechanical: true }, rules: [{ id: "allow-structural-search", decision: "allow", reason: "Symbol-accurate code search (read-only)", priority: 50 }] },
  view_image:  { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], tags: ["image-view"], blurb: { say: "what's in this screenshot?", does: "Look at an image you share." }, timeoutMs: 10_000, offBoxFetch: true, pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-view-image", decision: "allow", reason: "Image viewing (path-checked); base64-ships the image off-box to the vision API", priority: 50 }] },
  transcribe_media:   { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], tags: ["audio"], offBoxFetch: true, pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-transcribe-media", decision: "allow", reason: "Transcribes a local recording (path-checked read); ships audio off-box when a CLOUD stt provider is configured", priority: 50 }] },
  read_video_frames:  { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], tags: ["video"], offBoxFetch: true, pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-read-video-frames", decision: "allow", reason: "Samples frames from a local video (path-checked read); base64-ships them off-box to the vision API", priority: 50 }] },
  send_video:  { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], tags: ["video"], blurb: { does: "Send/attach a video." }, offBoxFetch: true, destination: [{ to: "user", message: true }], category: "connector", pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-send-video", decision: "allow", reason: "Sends a local video to the user over their own bridge (path-checked read)", priority: 50 }] },
  send_image:  { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], tags: [], offBoxFetch: true, destination: [{ to: "user", message: true }], category: "connector", pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-send-image", decision: "allow", reason: "Sends a local image to the user over their own bridge (path-checked read)", priority: 50 }] },
  send_file:   { kernel: "file", ariAction: "read", risk: "safe", capabilities: ["egress"], tags: [], offBoxFetch: true, destination: [{ to: "user", message: true }], runControl: true, pathArgs: [{ arg: "path", action: "read" }], rules: [{ id: "allow-send-file", decision: "allow", reason: "Stages a local document for the user's own device to fetch (path-checked read)", priority: 50 }] },
  // The kernel file bridge opens the caller's `path` for its `action`; the
  // action-conditional specs fail closed, so a call must name read or write.
  // The ari_* bridges derive runId/principal from the trusted session
  // (arikernel-bridge.ts), never from a model-supplied `_runId`. The bridge
  // runs the kernel's own file executor, which is raw disk I/O: the dispatch
  // gate judges it in the kernel like `read` and `write` (the bridge itself
  // never asked the kernel's policy engine).
  ari_file:    { kernel: "file", ariAction: { arg: "action", writes: ["write"], otherwise: "read" }, risk: "workspace-write", capabilities: ["sensitive-read"], tags: [], reads: ["session"], pathArgs: [
    { arg: "path", action: "read",  forActions: ["read"] },
    { arg: "path", action: "write", forActions: ["write"] },
  ] },

};
