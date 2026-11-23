# Security modes: decide by who asked and what it reaches

Status: proposal, 2026-11-22. Waiting on the owner's answers in §2.

## 1. The rule

Two questions decide whether the agent goes ahead, asks you or refuses.

1. **Who started this?**
   - **You**: you typed it in chat, or you started the build, scheduled job or
     run it belongs to.
   - **Someone else**: an email the mail watcher picked up, or a bridge message
     from a sender who isn't you.
2. **What does the action reach?** Outside content (a web page, an email, a
   fetched file, another person's message) only matters for actions it could
   turn against you.

| What the action reaches | Examples | You started it, nothing outside read | You started it, outside content read in this chat | Someone else started it |
|---|---|---|---|---|
| **Your project, undoable** | Edits, builds, tests, package installs, deletes inside the project | Goes ahead | Goes ahead | Goes ahead, in its own worktree |
| **Leaves the machine, or changes who commands the agent** | A message sent as you, private content to a site you didn't name, pairing and unpairing, allowed numbers, Telegram owner, integrations, starting autopilot | Goes ahead | Asks, and the card says what was read (`externalSourcesOf`) | Refused (parked in the inbox) |
| **Can't be undone** | The limits in §2a | Limit | Limit | Limit |

Why this and not "ask every time":
- When you ask, the agent doing it is the point. A card there only adds a
  click, and you ask LAX to unpair your phone or show the pairing QR all the
  time.
- What LAX has that a terminal session doesn't is exposure. Strangers can put
  text in front of it (email, bridges, web pages) while you're away. The
  middle and right columns are for exactly that.
- A build you started counts as you asking. Everything inside the project stays
  quiet however much the build reads. It asks only before sending something out
  after reading a page that could have planted the idea.

"You asked" means you asked for the task, not for each step. "Build me an app"
doesn't mean "pay for a domain" or "delete Downloads". That's why the last row
isn't decided by who asked: it's the limits list.

**What the mode changes.** Only the guesses: checks that fire on how something
looks rather than on what it is (§5). That's where a frontier model and a local
model really differ. The table above is the same in every mode.

## 2. Decisions for you

### 2a. The limits: on in every mode, whoever asked

Strike any you want dropped, and add any that are missing.

| # | Limit | Today, in your mode (Autonomous) |
|---|---|---|
| L1 | A vault secret goes only to a site it's bound to; a new site asks you (ADR 0005) | Asks |
| L2 | The agent can't change its own security settings (mode, sandbox, web access, autonomy, secrets, operator credential). Your ruling, 2026-10-02 | Refused (`src/rbac-agent-denials.ts`), a card for the `setting` tool |
| L3 | Agent writes to LAX's own control files (hooks, MCP trust, plugins) ask you. Your ruling, 2026-10-02 | Card |
| L4 | Nothing is written into system folders, the LAX install, or key and secret files | Refused |
| L5 | No requests to cloud-metadata addresses or private-network IPs | Refused |
| L6 | Spending money asks you | **Allowed without asking. Your call:** I'd make it a limit. |
| L7 | A deletion outside the project folder asks you (`rm -rf`, `dd`, force-push) | Card |
| L8 | A publish the review marks RED is blocked unless you override it on the card | Blocked + card |
| L9 | A value already known to be a secret is never typed into a shell line that goes to the network | Refused |
| L10 | A message is sent as you only through the send tools (`whatsapp_send`, `telegram_send`, email), never by a direct request to LAX's own send routes | **Open today** (§3) |

Who may command the agent (owner, allowed numbers, pairing, sign-out) is on
purpose not a limit. You ask for these, so a limit would break real requests.
§1's middle row covers the risky case.

### 2b. "Outside content read": this chat, or since your last message?

- **This chat (recommended).** Once the chat has read outside content, outward
  actions ask for the rest of the chat. That's how LAX tracks it today
  (`hasExternalIngestion`, sticky for the session), and it's safer: text read
  three messages ago is still in front of the model and can still steer it.
- **Since your last message.** Quieter, but your new message doesn't remove
  what the page said from the model's context.

With "this chat", the "Trust this chat" button (§2e) is how you quiet a long
chat that read a lot.

### 2c. Mode names

The five-profile picker exists today (Safe, Normal, Developer, Power,
Autonomous; Settings → Security → Autonomy). Recommendation: **show three,
keep five underneath**:

| Shown | Built from | Default for |
|---|---|---|
| **Strict** | Safe, plus "ask before each new site" web access | Local models |
| **Guarded** | Power | Frontier models, new installs |
| **Trusted** | Autonomous, plus §5's Trusted column | Nothing by default |

Normal and Developer stay under "Custom" for anyone already on them. Nobody's
saved profile changes.

### 2d. Defaults by model

Two pickers instead of one: **"With frontier models"** (default Guarded) and
**"With local models"** (default Strict). Local means the chat's model runs on
this machine. You set each once, and each turn uses the one that matches its
model.

### 2e. Per-chat trust

Every approval card gets a **"Trust this chat"** button. It does two things
until the chat ends:
- treats the chat as clean (§1's first column);
- uses Trusted's guesses (§5).

Your saved mode doesn't change, and neither do the limits. A build's worker
agents inherit it. The session override it uses already exists
(`setSessionProfile` in `src/autonomy/profile-store.ts`; cron jobs use it).

## 3. What's true today

You're already on **Autonomous**, the loosest profile
(`~/.lax/autonomy-profile.json`). Every card that stopped you today came from a
check the profile doesn't reach:

| What stopped you | Where it lives | Profile decides it? |
|---|---|---|
| "Type /approve" after a download | Threat engine, after the call (`src/tool-execution/audit-tool-call.ts` `evaluateThreat`) | No. Also a bug: it judged a call that never ran (fixed, 5c7c52817) |
| "Could be a password" (Firebase id, Expo link) | Outbound secret scan, advisory tier (`src/tools/http-egress-guard.ts`) | No |
| Chunk 6 refused over `EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN` | A name masked and saved as a secret | No. Also a bug (fixed, b64d01676) |
| A card after reading a page, before sending | `src/tool-execution/private-content-gate.ts` | No, it asks under every profile |

Other facts the plan relies on:

- **The agent's requests to LAX's own server** carry the agent's identity
  (`selfCallAuthHeader`, `src/tools/web-egress.ts`). A fixed list of routes
  refuses it (`src/rbac-agent-denials.ts`). Every other route accepts a change
  from the agent with no check, including `/api/whatsapp/send` and
  `/api/telegram/send`. That's how the agent shows you the pairing QR today, and
  also a path no mode reaches.
- **Who started a turn** is partly recorded. `callContext` (`local`, `api`,
  `delegated`, `cron`, in `src/security/layer/types.ts`) and `chatUnattended`
  (`src/chat-ws/broadcast.ts`) cover chat versus background. Which sender
  started a bridge or mail turn has to be carried to the tool call (§6, step 3).
- **Outside reads** are tracked per chat. `hasExternalIngestion` and
  `externalSourcesOf` live in `src/data-lineage/external.ts`, and
  `control-file-gate.ts` already decides by them.
- **Nothing in security varies by model** today.
- **The threat engine's pre-call pack is unwired**
  (`src/tool-policy/packs/threat-engine-pack.ts`): `enforce-policy.ts` never
  passes it the engine.

## 4. Today's checks, placed in §1

| Today's check | Where it lands |
|---|---|
| Private content to a site you didn't name (`private-content-gate.ts`) | §1, leaves the machine |
| Injection exposure (`injection-exposure.ts`, per-profile list) | §1: a planted-looking instruction counts as outside content read |
| Tainted shell or request (`egress-gates.ts` `lineageBlocker`) | §1, leaves the machine, with Declassify as today when it refuses |
| Sends (`whatsapp_send`, `telegram_send`, email) | §1, leaves the machine; their recipient rules stay |
| Changes through LAX's own server (pairing, owner, allowed numbers, integrations, autopilot, update) | §1, changes who commands the agent |
| Control-file writes (`control-file-gate.ts`) | L3; already decided by who asked and outside reads |
| Vault secret to a new site, `secret_env` | L1; `secret_env` asks per program and secret except in a clean chat you started |
| Deletes, publish, money | Inside the project goes ahead; L6, L7, L8 for the rest |
| Ari kernel, sandbox, worktree fence, file-access refusals, kill switches, plan mode | Unchanged, outside this plan |

## 5. What the mode changes: the guesses

"Ask" is a card in an attended chat and parked in the inbox otherwise. "Note"
means the call goes through and the activity log records what the check saw.

| Row | Guess | Strict | Guarded | Trusted |
|---|---|---|---|---|
| A | A random-looking value to a site that never showed it | Ask | Ask, with **"Always allow this site"** | Note |
| B | A known key format (`sk-ant-…`, `ghp_…`) not in your vault, to a site not on your trusted list | Refused | Refused | Ask |
| T | Threat engine: a chain of calls that looks like exfiltration | Block, `/approve` | Ask (a card, not typed `/approve`) | Note |
| G | A site the agent hasn't visited before | Ask ("Allow & retry") | Open | Open |

These are the only per-mode rows. Everything else is §1 or a limit.

## 6. How it's built

**Canonical-check: EXTEND.** The owners stay where they are:
- the autonomy profile (`src/autonomy/profiles.ts`, through `src/approval-decision.ts`) owns the mode;
- `src/data-lineage/external.ts` owns outside reads;
- `src/tool-execution/require-approval.ts` owns the card.

No new settings file and no second switch.

1. **`whoAsked(ctx)`** in `src/approval-decision.ts` returns `you-clean`,
   `you-read-outside` or `someone-else`, from `callContext`, `chatUnattended`,
   `hasExternalIngestion`, the session's trust override (§2e) and the turn's
   starter (step 3).
2. **`reach(ctx)`**, beside it, returns `project`, `outward` or `limit`. It
   comes from facts the policy rows already declare: `capabilities` (`egress`),
   `destination`, `pathArgs` against the project folder, `risk`, `publish`. A
   self-call to LAX's own server that changes something (any method but GET or
   HEAD) is `outward`. That covers every route, including future ones, with no
   list to maintain.
3. **The turn's starter** is carried on the tool call, as `operationIdOf` and
   `sessionIdOf` (`src/tool-execution/internal-args.ts`) are. Bridges and the
   mail watcher record who sent the message that started the turn. A message
   from the owner's own account counts as you.
4. **One decision** in `require-approval.ts` reads the two and §1's table.
   The checks in §4 stop deciding alone and call it. Each keeps its own card
   wording and its Declassify or Allow & retry button.
5. **The guesses** (§5) become a `guesses` table on each profile (A, B, T, G),
   read through `checkDecision(row, ctx)`. Its readers are
   `http-egress-guard.ts`, `audit-tool-call.ts` and the strict-web branch of
   `network-policy.ts`. The type makes every profile fill every row.
6. **The limits stay in code**, where they are today. A test drives each one
   under Trusted with a trusted chat (§8).
7. **The model class** comes from the existing `isLocalModelEndpoint`
   (`src/local-runtimes/model-endpoint.ts`). The two pickers are two keys in
   `~/.lax/autonomy-profile.json` (`frontier`, `local`). The old `profile` key
   is read as `frontier` once, then rewritten.
8. **Threat engine.** The after-call block reads row T. The unwired pre-call
   pack is deleted, not wired; that's listed so you can object.
9. **UI.**
   - The Autonomy section becomes three cards (Strict, Guarded, Trusted), each
     with what it asks about, and "Custom" shows the old five.
   - The approval card gets "Trust this chat" and, on row A, "Always allow this
     site".
10. **Phone.** The new card buttons are new approval actions on the broker
    wire. They need the agentxos change first, then the vendor sync. Until
    then, the phone shows the card without them.

## 7. Order of work

0. **L10, now, on its own.** `/api/whatsapp/send` and `/api/telegram/send`
   join `src/rbac-agent-denials.ts`, with `place` naming the send tool so the
   agent is pointed at `whatsapp_send` / `telegram_send`. The agent already has
   those tools and nothing you do uses the direct routes, so nothing changes for
   you.
1. **`whoAsked`, `reach` and the turn's starter**, recorded and logged on every
   tool call but deciding nothing yet. A day of your real use shows where §1's
   table would have asked, before it does.
2. **§1 decides.** The §4 checks call the one decision. This is the change you
   feel: builds go quiet inside the project, your own requests go through, and
   outward actions ask only after outside reads.
3. **The guesses table (§5)**, reproducing today's behavior for each profile,
   then Trusted's column.
4. **Guarded's card for row T** (replacing typed `/approve`) and "Always allow
   this site".
5. **Model-class defaults (§2d).**
6. **"Trust this chat" (§2e)**, desktop first, then the phone (agentxos, OTA).
7. **The three-card picker.**

Each step is its own commit with tests. Steps 0 to 5 don't touch the phone
wire.

## 8. Tests

- `src/tool-execution/who-asked.test.ts`: every cell of §1's table, driven <!-- doc-paths:ignore -->
  through `executeToolCalls` with real gates (the harness in
  `refused-call-not-threat-judged.test.ts`). Cases: <!-- doc-paths:ignore -->
  - "unpair my phone" and "show me the pairing QR", typed in a clean chat: no card;
  - the same after a web read: a card naming the site read;
  - the same from a scheduled job, or a turn a non-owner's message started: refused;
  - a build that read npm docs, editing and deleting inside its project: no card;
  - the same build sending an email: a card.
- `src/tool-execution/limits-hold-under-trusted.test.ts`: each of L1 to L10 <!-- doc-paths:ignore -->
  under Trusted, in a trusted chat you started.
- `src/autonomy/profile-guesses.test.ts`: every profile fills rows A, B, T, G, <!-- doc-paths:ignore -->
  and step 3's tables reproduce today's decisions. Today's real cases per row:
  the Firebase console URL (A), `token=sk-ant-…` (B), the expo.dev download
  chain (T).
- Model class: the same chat on a local model and on a frontier model gets
  each picker's guesses.
- A direct POST to `/api/whatsapp/send` is refused whoever asked, and names
  `whatsapp_send`.

## 9. What this doesn't do

- **It doesn't make the model the defense.** After outside content is read,
  outward actions ask even in Trusted. Both of today's workarounds (shell
  variables plus curl, and a worker switching tools past the filter) came from
  our own agents trying to finish, not from an attacker.
- **It doesn't fix false alarms by loosening.** A false alarm is a bug in every
  mode. Fixed today:
  - the double approval
  - a variable name treated as a secret
  - the Firebase id
  
  Still open: page words like "Share" masked as secrets (not yet reproduced).
- **It doesn't close the shell egress gap.** Under the cage, a curl request is
  judged only by its host. A command that reads a credential and sends it is
  `outward`, so §1 asks after outside reads, but string parsing can't see every
  send. The network-layer design (`docs/shell-egress-network-layer-design.md`)
  is that work.
