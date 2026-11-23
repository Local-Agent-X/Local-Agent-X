# Security modes: one switch that decides every ask

Status: proposal, 2026-11-22. Waiting on the owner's answers in §1.

## 1. Decisions for you

### 1a. The rule underneath: who asked

The question for an action is who asked for it, not how risky it is.

| Situation | What happens |
|---|---|
| **You asked** in this chat, and the agent has read nothing from outside (web page, email, fetched file, someone else's bridge message) since your last message | It does it. No card. |
| **Outside content read**: the agent has read something from outside since your last message | It asks before anything that changes or sends |
| **Nobody there**: an unattended run (scheduled job, mail watcher, long build), or a turn started by someone else messaging a bridge | It refuses, or parks the action in the inbox |

Why this rule and not "ask every time":
- When you ask in your own words, the agent acting on it is the point. A card
  there only adds a click: unpairing your phone, showing the pairing QR,
  changing the allowed numbers.
- What LAX has that a terminal session doesn't is exposure. Strangers can put
  text in front of it (WhatsApp, Telegram, the mail watcher, web pages) while
  you're away. The second and third rows are for exactly that.

The modes in §1c tune what the agent does in the first row. The limits in §1b
hold in every row.

### 1b. The limits: what stays on in every mode, even Trusted

Each line is a check that stays on even when you pick the loosest mode. Strike
any you want Trusted to drop, and add any that are missing.

| # | Limit | Today, in your mode (Autonomous) | Why it stays |
|---|---|---|---|
| L1 | A vault secret goes only to a site it is bound to; a new site asks you (ADR 0005) | Asks | It's the one leak you can't take back, and the check is exact, so it never fires by mistake |
| L2 | The agent can't change its own security settings (mode, sandbox, web access, autonomy) | Refused in unattended runs, a card in chat | Your ruling, 2026-10-02 |
| L3 | Agent writes to LAX's own control files (hooks, MCP trust, plugins) ask you | Card | Your ruling, 2026-10-02 |
| L4 | Nothing is written into system folders, the LAX install, or key and secret files | Refused | A refusal, not a card: nothing legitimate needs it |
| L5 | No requests to cloud-metadata addresses or private-network IPs | Refused | That's how an injected page reaches your router or cloud keys |
| L6 | Spending money asks you | **Allowed without asking** | **Your call.** Today Autonomous lets the agent pay. I'd make this a limit. |
| L7 | A deletion outside the project folder asks you (`rm -rf`, `dd`, force-push) | Card | Inside the project, Trusted allows it with rollback (§3) |
| L8 | A publish the review marks RED is blocked unless you override it on the card | Blocked + card | The review is the safety net for "allowed without asking" |
| L9 | A random-looking value that appeared in the agent's own context from a secret file or masked output is never typed into a shell line bound for the network | Refused | It's the known-secret shell gate: an exact match, never a guess |
| L10 | A message is sent as you (WhatsApp, Telegram, email) only through the send tools, never by a direct request to LAX's own send routes | **Open today** | The send tools check who the message goes to; the direct route skips that check. Nothing you do uses it (§2). |

Not a limit, on purpose: who may command the agent (Telegram owner, WhatsApp
allowed numbers, phone pairing and unpairing, sign-out). You ask the agent to
do these, so a limit would break real requests. The rule in §1a covers the
risky case: an injected page asking for them gets a card, and a stranger's
bridge message gets a refusal (row S, §3).

### 1c. The mode names and how many

The five-profile picker exists today (Safe, Normal, Developer, Power,
Autonomous; Settings → Security → Autonomy). My recommendation: **show
three, keep five underneath**:

- **Strict** = Safe's table, plus "ask before each new site" web access.
- **Guarded** = Power's table. This is the default for new installs.
- **Trusted** = Autonomous's table, plus the changes in §3, which is what makes it actually quiet.

Normal and Developer stay available under "Custom" for anyone already on
them. Nobody's saved profile changes.

### 1d. Defaults by model

Two pickers instead of one: **"With frontier models"** (default Guarded)
and **"With local models"** (default Strict). Local means `ollama`, `local`,
or any provider that runs on this machine. You set each once; a chat uses the
one that matches its model when each turn starts.

### 1e. Per-run trust

When an approval card appears, it gets a **"Trust this chat"** button. It
switches that chat (or that build, including its worker agents) to Trusted
until the chat ends. It doesn't change your saved mode. The session override
it uses already exists: `setSessionProfile` in `src/autonomy/profile-store.ts`,
which cron jobs use today.

## 2. What's true today (why modes alone didn't help)

You're already on **Autonomous**, the loosest profile
(`~/.lax/autonomy-profile.json`). Every card that stopped you today came from
a check the profile doesn't reach:

| What stopped you | Where it lives | Does the profile decide it? |
|---|---|---|
| "Type /approve" after a download | Threat engine, after the call (`src/tool-execution/audit-tool-call.ts` `evaluateThreat`) | No. Also a bug: it judged a call that never ran (fixed, 5c7c52817) |
| "Could be a password" card (Firebase id, Expo link) | Outbound secret scan, advisory tier (`src/tools/http-egress-guard.ts`) | No |
| Chunk 6 refused over `EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN` | Masked value registered as a secret, then the exact-match block | No. Also a bug: a name isn't a value (fixed, b64d01676) |
| A card after reading a web page or email, before sending anywhere | `src/tool-execution/private-content-gate.ts` (policy-forced ask) | No, it asks under every profile |

So the plan isn't "add modes". It's **make the mode the one thing that
decides every ask**, so that picking Trusted actually means it, while the
limits in §1b stay true in every mode.

Two more facts from the inventory that the plan relies on:

- Nothing in security varies by model today. The only model check is a warning
  in `src/browser/sensitive-pages.ts` `secrecyOpenWarning`.
- The agent's requests to LAX's own server carry the agent's own identity
  (`selfCallAuthHeader` in `src/tools/web-egress.ts`), and a fixed list of
  routes refuses it (`src/rbac-agent-denials.ts`: secrets, security settings,
  autonomy, sandbox and others). Every other route, including
  `/api/whatsapp/send` and `/api/telegram/send`, accepts a change from the
  agent with no check at all. That's how the agent shows you the pairing QR
  today, and it's also a path no mode reaches.
- The threat engine's pre-call pack (`src/tool-policy/packs/threat-engine-pack.ts`)
  isn't wired: `enforce-policy.ts` never passes it the engine, so it allows
  everything. Its only live effect is the after-call block. The plan settles
  that (§3, row T).

## 3. Each check, by mode

"Ask" is a card in an attended chat. In an unattended run it is parked in the
inbox, as today. "Note" means the call goes through and the activity log says
what the check saw. "By who asked" is the §1a rule: you asked, it goes
through; outside content read, it asks; nobody there, it refuses.

Row S is the same in every mode on purpose. The mode tunes guesses (A, B, T);
who asked is what decides a change to the agent's own app.

| Row | Check | Strict | Guarded | Trusted |
|---|---|---|---|---|
| A | Random-looking value to a site that never showed it (advisory secret scan, browser and `http_request`) | Ask | Ask, with **"Always allow this site"** | Note |
| B | Known key format (`sk-ant-…`, `ghp_…`) not in your vault, to a site not on your trusted list | Refused | Refused | Ask |
| C | Vault secret to a site it isn't bound to | Ask (L1) | Ask (L1) | Ask (L1) |
| D | Private content (an email, a file you didn't attach) to a site you didn't name | Ask | Ask | By who asked (§1a): you asked → Note; outside content read → Ask |
| E | Tainted shell or request (secret bytes entered the chat) | Refused, Declassify button | Refused, Declassify button | Ask |
| T | Threat engine: a chain that looks like exfiltration | Block, `/approve` | Ask (a card, not typed `/approve`) | Note |
| F | Injection exposure (a tool result carried a planted-looking instruction) | Ask before outward actions | Note | Note |
| G | New site, strict web access | Ask ("Allow & retry") | Open | Open |
| H | Deleting inside the project folder | Ask | Allowed | Allowed, with rollback |
| I | Deleting outside the project folder | Ask (L7) | Ask (L7) | Ask (L7) |
| J | Publish (push, deploy, release) after a green review | Ask | Allowed | Allowed |
| K | Money | Refused | Ask | Ask (L6, if you keep it) |
| L | `secret_env` (a program gets a vault secret as an env var) | Refused | Ask per program and secret | Allowed |
| N | Message sent as you (WhatsApp, Telegram, email), through the send tools | Ask | Ask for a recipient you didn't name | Allowed, unless outside content was read (then Ask) |
| S | A change to LAX itself through its own server: pairing QR, unpair, allowed numbers, Telegram owner, integrations (plugins and MCP servers stay refused: L2, L3), update, starting autopilot or an eval run | By who asked (§1a) | By who asked (§1a) | By who asked (§1a) |
| M | Everything in §1b | Same in every mode | | |

Unchanged in every mode, and not part of this plan:
- The sandbox (cage) stays on. It's a separate setting, and Trusted doesn't turn it off.
- The Ari kernel's refusals.
- The worktree fence.
- File-access refusals.
- Kill switches.
- Plan mode.

## 4. How it's built (one owner, no second switch)

**Canonical-check: EXTEND.** The owner is the autonomy profile
(`src/autonomy/profiles.ts`, read through `src/approval-decision.ts`). No new
setting file and no new mode store.

1. **The profile grows one table.** Next to the risk `rules`, each profile
   gets a `checks` table keyed by the §3 rows: `advisory-secret`,
   `known-format-secret`, `private-content`, `taint`, `threat-chain`,
   `strict-web`. Each value is `refuse | ask | note`. The type makes every
   profile fill every row, so a new check can't default to silence.
2. **Each check asks the profile instead of deciding alone.** One function,
   `checkDecision(check, ctx)` in `src/approval-decision.ts`, returns the
   effective decision. It reads the session override, then the model-class
   default, then the saved profile.
   - Readers: `http-egress-guard.ts` (A, B), `private-content-gate.ts` (D),
     `egress-gates.ts` `lineageBlocker` (E), `audit-tool-call.ts`
     `evaluateThreat` (T), and the strict-web branch in `network-policy.ts` (G).
   - Each one already knows how to refuse or ask; only the choice moves.
3. **The limits are code, not rows.** L1 to L10 stay where they are, and no
   profile row can reach them. A test lists them and checks that they hold
   under Trusted (§6).
4. **Model class.** A chat's model is local when its endpoint is, decided by
   the existing `isLocalModelEndpoint` (`src/local-runtimes/model-endpoint.ts`),
   the same check the local-model adapter already uses. The two pickers in §1d are two keys in
   `~/.lax/autonomy-profile.json` (`frontier`, `local`). The old `profile` key
   is read as `frontier` once, then rewritten.
5. **Who asked, row S and the rule in §1a.** One function, `whoAsked(ctx)`,
   returns `you`, `outside-read` or `nobody`.
   - It reads two things the code already tracks: whether the session read
     outside content since the user's last message (what row D and memory
     promotion read today), and whether the turn has a user attached and was
     started by the owner (`callContext` in `require-approval.ts`; a bridge
     message from someone other than the owner counts as `nobody`).
   - Row S is decided in one place: the self-call path in
     `src/tools/web-egress.ts`, for any method that changes something (not
     GET or HEAD). That covers every route, including ones added later, with no
     list to keep up to date.
   - `src/rbac-agent-denials.ts` stays as it is. Its routes are L2 and L4, and
     they stay refused whoever asked.
   - L10: `/api/whatsapp/send` and `/api/telegram/send` join that list, with
     `place` naming the send tool, so the agent is told to use
     `whatsapp_send` / `telegram_send` instead.
6. **Threat engine, row T.**
   - The after-call block becomes a decision: Strict blocks as today; Guarded
     shows a card that ends in the same consent store `/approve` writes; Trusted
     records a note.
   - The unwired pre-call pack is deleted rather than wired, since §3 doesn't
     need it. That's a deletion, and it's listed in the change so you can
     object.
7. **The UI.**
   - The Autonomy section becomes the mode picker: three cards (Strict,
     Guarded, Trusted), each with a one-line "what it asks about"; a "Custom"
     link shows the old five.
   - The approval card gets "Trust this chat" (§1e) and, for row A, "Always
     allow this site" (it adds the host to the trusted list, which already
     exempts it from A).
8. **The phone.** The approval card's new buttons are new approval actions on
   the broker wire. They need the agentxos change first, then the vendor sync
   (root AGENTS.md). Until then, the phone shows the card without them.

## 5. Order of work

0. **L10, now, on its own**: deny the two direct send routes. The agent
   already has `whatsapp_send` and `telegram_send`, and nothing in the app's
   pages calls those routes with the agent's identity, so nothing you do
   changes. It doesn't depend on the rest of this plan.
1. **Profile `checks` table + `checkDecision`**, wired into A, D, E, T, G, with
   no change in behavior. Every profile's table reproduces today's decisions
   exactly, and a test pins that. Small and safe; it moves no decision.
2. **Trusted's new rows**: A to Note, D to Note-when-clean, E to Ask, T to Note
   for Autonomous, plus the limits test. This is the change you'll feel.
3. **`whoAsked` and row S** on the self-call path, plus row N. After
   this, an injected page can't change who commands the agent without a card,
   and your own requests stay as quiet as today.
4. **Guarded's card for T** (replacing typed `/approve`) and **"Always allow
   this site"** on row A.
5. **Model-class defaults (§1d).**
6. **"Trust this chat" (§1e)**, desktop first, then the phone (agentxos, OTA).
7. **The three-card picker.**

Each step is its own commit with its tests. Steps 0 to 5 don't touch the
phone wire.

## 6. Tests

- `src/autonomy/profile-checks.test.ts`: every profile fills every row, and <!-- doc-paths:ignore -->
  step 1's tables reproduce today's decisions.
- `src/tool-execution/limits-hold-under-trusted.test.ts`: under Trusted, each <!-- doc-paths:ignore -->
  of L1 to L10 still refuses or asks, driven through `executeToolCalls` with
  real gates (the same harness as `refused-call-not-threat-judged.test.ts`). <!-- doc-paths:ignore -->
- One test per moved check, asserting all three modes' outcomes for today's
  real cases:
  - the Firebase console URL (A)
  - `token=sk-ant-…` to an untrusted host (B)
  - an email body to a site the user didn't name, clean vs. after a web read (D)
  - the expo.dev download chain (T)
- Who asked, row S, driven through a real self-call: "show me the pairing QR"
  and "unpair my phone" typed by the user go through with no card; the same
  calls after a web read ask; the same calls in a scheduled job, or in a turn
  started by a non-owner's Telegram message, are refused. A direct POST to
  `/api/whatsapp/send` is refused in all three and names `whatsapp_send`.
- Model class: a local-model chat with the frontier picker on Trusted and the
  local picker on Strict asks on row A; the same chat on a frontier model doesn't.

## 7. What this doesn't do

- **It doesn't make the model the defense.** Row D still asks in Trusted after
  the agent has read web or email content. Both of today's workarounds (shell
  variables plus curl, and a worker switching tools past the filter) came from
  our own agents trying to finish, not from an attacker, so the limits don't
  trust the model's judgment.
- **It doesn't fix false alarms by loosening.** A false alarm is a bug in every
  mode. Fixed today:
  - the double approval
  - a variable name treated as a secret
  - the Firebase id
  
  Still open: page words like "Share" masked as secrets (not yet reproduced).
- **It doesn't close the shell egress gap.** Under the cage, curl's request is
  judged only by its host. That's `docs/shell-egress-network-layer-design.md`'s
  work, separate from modes.
