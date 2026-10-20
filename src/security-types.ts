// The security layer's decision shape and the user-facing hints every block
// site reads. Split from types.ts, the shared type barrel; types.ts
// re-exports it, so importers are unchanged.


/** A control the user can click to end a class of block (see SecurityDecision.action). */
export interface BlockAction {
  kind: "allow-host";
  host: string;
}

export interface SecurityDecision {
  allowed: boolean;
  /** Technical reason — for logs, audit, and developer debug. */
  reason: string;
  /**
   * Plain-English summary the model surfaces to the user. Optional so legacy
   * block sites still compile; the formatter falls back to `reason` when
   * absent. Convention: one line, no jargon, names what was attempted in user
   * terms, offers 1-2 next steps the user can take. Use the canonical
   * templates in `USER_HINTS` instead of writing per-site sentences — pair
   * with the "translate tool failures, never parrot" prompt rule.
   */
  userHint?: string;
  /**
   * Suggested next move for the model when blocked — surfaces as a "Recovery:"
   * line adjacent to the tool result (see result-helpers renderToolResultForModel).
   * Right-time guidance so a denied call doesn't leave the model stuck.
   */
  recovery?: string;
  /**
   * A control the USER can click to end this class of block: rendered on the
   * chat notice, never re-derived from reason text. "allow-host" adds `host`
   * to the strict-mode egress allowlist (POST /api/security/egress).
   */
  action?: BlockAction;
  quarantined?: boolean;
  /**
   * Canonical (realpath-resolved, every symlink/junction segment followed)
   * absolute path the gate validated. Populated only when `allowed` is true.
   * Sinks open THIS inode (via the read helper, with O_NOFOLLOW on the leaf)
   * so the path the gate approved is byte-for-byte the path opened — closing
   * the check-on-string / open-on-inode symlink-swap TOCTOU (R4-19). Callers
   * that only need the allow/deny verdict ignore it.
   */
  canonicalPath?: string;
}

/**
 * Static, English-only user-facing hints for blocked-tool responses. Each
 * category collapses many block sites into one sentence so the model surfaces
 * a consistent message regardless of which underlying rule fired. Block sites
 * import the matching key — they MUST NOT invent per-site prose.
 */
export const USER_HINTS = {
  /** SSRF, egress allowlist, invalid URL, blocked protocol — genuine
   *  destination/connectivity failures ONLY. NOT the threat-restriction deny
   *  (that uses `threatRestricted`) and NOT outbound-content blocks — secret in
   *  payload, session taint, canary trip, sensitive attachment (those use
   *  `outboundContent`). Framing a security block as a connectivity problem
   *  sent a live session into a network-debugging flail (2026-07-23). */
  network:
    "I can't reach that URL or network address right now — want me to skip it, use a local file, or try a different address?",
  /** Session threat restriction denied an external call. Must never read as a
   *  network failure: the destination was never contacted — the security layer
   *  blocked the call because of recorded evidence (the reason line names it). */
  threatRestricted:
    "A security check is blocking external calls in this session because of earlier evidence (see the reason above) — this is not a network failure; the site was never contacted. Type `/approve <one-line reason>` if this work is legitimate, or keep working locally and the restriction lifts on its own after quiet turns or time.",
  /** Outbound payload blocked for its CONTENT, not its destination: a hardcoded
   *  secret, a sensitive file attachment, session-tainted data, or a tripped
   *  canary token. Must never read as a network failure — the address is fine,
   *  the DATA can't leave. The old `network` hint told the model to "use a local
   *  file / try a different address", the exact opposite of the fix (2026-07-23). */
  outboundContent:
    "That outbound call was blocked for what it carries, not where it's going — the payload contains a secret, a sensitive file, or data that can't leave this session. This is not a network problem; changing the address won't help. Remove or mask the sensitive content (use {{SECRET_NAME}} placeholders for credentials) and retry.",
  /** Path traversal, workspace boundary, file-access-mode restrictions. */
  fileSystem:
    "I can't access that file path — try a path inside the project or your usual user folders, or broaden file access in Settings.",
  /** Sensitive credential files AND protected platform/engine sources. */
  secrets:
    "I can't touch credential files or platform internals — give me a different path, or you'll need to edit that file yourself.",
  /** Delegated agent + source-code write/edit/bash without a sandbox. */
  worktreeIsolation:
    "A delegated agent can't run shell commands against source code without an isolated sandbox. If you were trying to run the project's build or type-check to verify your edits, you don't need to — the harness runs it automatically when the turn ends and hands back any real errors. Make your edits with the file tools and finish; verification is handled.",
  /** Tool-policy default-deny, rate cap by policy, blocked args, host allowlist, hook, RBAC, context-restricted tool. */
  policy:
    "That action isn't permitted by the current policy — tell me what you'd like instead, or relax the rule in ~/.lax/tool-policy.json.",
  /** Category kill-switch (enableShell/enableHttp/enableBrowser/enableComputerControl) flipped off.
   *  Distinct from `policy`: these live in Settings → Security, NOT tool-policy.json —
   *  pointing users (or the agent) at the policy file here sent a live agent
   *  diagnosing the wrong layer (2026-07-20, computer control). */
  killSwitch:
    "That tool category is switched off in Settings → Security — say the word and the agent can request it back on with your approval, or flip the toggle there yourself.",
  /** User declined the approval prompt for this specific call. */
  declined:
    "You declined this action — the agent will adjust its approach instead of retrying it.",
  /** Approval card expired unanswered (or the session tore down first). */
  approvalTimeout:
    "That action was waiting for your approval and the request expired — say the word if you want it to go ahead.",
  /** Pending approval dismissed because the user replied in chat instead of clicking. */
  approvalSuperseded:
    "You replied instead of clicking the approval card, so I'm reading your message — I can ask again if you want that action to proceed.",
  /** Security-kernel (ARI) block: missing tool mapping/grant, kernel inactive in
   *  ariRequired mode, kernel evaluation error. NOT fixable in user settings —
   *  pointing the agent at tool-policy.json here sent it diagnosing the wrong
   *  layer (2026-06-10, image_search). The reason line names the engine-level
   *  cause; the right move is report-the-bug, not edit-your-config. */
  kernel:
    "The security kernel blocked this tool call — this is an engine-level gate, not your settings. The reason below names the cause; if it mentions a missing mapping or grant, that's an app bug to report (or update the app), not something to fix in ~/.lax.",
  /** Shell metacharacters, heredoc + script writes, dangerous patterns, obfuscation. */
  commandShell:
    "I can't run that shell command — tell me what you're trying to do and I'll find a safer way (often a dedicated tool exists).",
  /** Plan mode is on — only read-only tools allowed. */
  planMode:
    "I'm in plan mode and can only read right now — say \"exit plan mode\" when you want me to start making changes.",
  /** ENFORCED plan mode — only the user's Plan toggle lifts it, not the model. */
  planModeEnforced:
    "Plan mode is on — I can research and propose changes, but the Plan toggle has to be turned off before I can make any.",
  /** Threat engine fired on tool result — needs `/approve` to continue. */
  threatConsent:
    "Something tripped a safety check — type `/approve <one-line reason>` if this is a legitimate request, or tell me a different approach.",
  /** Circuit breaker, per-tool rate limit, autopilot self-edit ceiling. */
  retryExhausted:
    "I've tried this several times and it keeps being denied — let's switch approaches; what should we do instead?",
} as const;

export type UserHintKey = keyof typeof USER_HINTS;
