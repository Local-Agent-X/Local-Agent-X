/**
 * op_submit_async — fire-and-forget delegation to the canonical-loop.
 *
 * PRIMARY verb. Returns opId immediately; the session bridge surfaces the
 * worker's result back into the chat session asynchronously. Three layers of
 * guarding (live-peer block, time-window dedup, casual-reply / similarity)
 * prevent the model from spawning duplicate workers on retry storms.
 */

import type { ToolDefinition } from "../../types.js";
import {
  canonicalLoopEntry,
  registerAdapterForOp,
} from "../../canonical-loop/index.js";
import { readOp } from "../op-store.js";
import { trackOpForSession, listOpsForSession } from "../session-bridge.js";
import {
  buildOpFromArgs,
  readSettingsProvider,
  submitParameters,
  RECENT_SUBMITS,
  SUBMIT_DEDUP_WINDOW_MS,
} from "./shared.js";

export const opSubmitAsyncTool: ToolDefinition = {
  name: "op_submit_async",
  description:
    "PREFERRED for any task >5 seconds. Delegates to a worker process and returns the opId IMMEDIATELY — your chat turn does not block. Submit ONCE per logical task; if you call this tool a second time with the same task in the same turn, you'll get the existing opId back (no second worker spawned). Tell the user 'started, I'll let you know when it's done' and move on. The user is automatically notified when the op completes via a chat update; you can also call op_status(opId) on any future turn. Use op_wait(opId) only if you genuinely need the result before answering the current turn. ALWAYS pass `lane` explicitly: use `lane:'interactive'` for pure reasoning / Q&A / summarization / research synthesis / status checks / planning / reviewing / explaining / non-mutating analysis (worker does NOT touch files or run builds), `lane:'build'` for code edits / app builds / file writes / refactors / shell or test work / OAuth + account / integration setup, `lane:'background'` for scheduled or low-priority recurring jobs. Picking the right lane matters — interactive ops finish in seconds; build ops can take minutes. CONTEXT-RELAY RULE: workers do NOT see the chat thread. If a delegated task depends on prior context (a service name, handle, business, file, prior decision), include it explicitly in `task` / `scope_hint` / `context_files` / `memory_query` — otherwise the worker guesses and is usually wrong. OAUTH / ACCOUNT-CONNECTION / INTEGRATION-SETUP tasks must include in the task string: (1) target service or platform (e.g. Instagram, Gmail, Stripe), (2) account / business / handle if known, (3) intended outcome (e.g. 'read DMs', 'post on behalf of'), (4) whether user-side auth is expected. AMBIGUITY GUARD: if any of those four is unclear from the conversation (e.g. user said 'connect my account' with no service named, or you have multiple plausible accounts), ASK FOR CLARIFICATION before delegating — do not pick a default integration. Example: 'Do you mean Instagram for @account_a, or @account_b for the store?'. USER-AUTH GATE: if the task requires `/mcp`, OAuth browser approval, 2FA, or any user authorization a backgrounded worker cannot perform, SURFACE THAT TO THE USER FIRST and tell them what to run; do not spawn a worker that will just bail with WORK_NEEDS_INPUT. Keep OAuth / account-connection work on lane='build' (it mutates credentials/config); never reroute to 'interactive'.",
  parameters: submitParameters,
  async execute(args) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "op_submit_async requires a 'task' description.", isError: true };

    const sessionId = String(args._sessionId || "");
    if (sessionId) {
      // PRIMARY GUARD: any PEER op from this session still RUNNING blocks
      // new spawns regardless of how much time has passed. Live failure:
      // agent submitted an op that ran 125+ seconds; the 30s dedup window
      // expired mid-run, so the agent's retry calls SUCCEEDED in spawning
      // duplicates. By the time the user noticed they had 4 parallel
      // research ops on the same topic. Block while live.
      //
      // EXCLUDE chat_turn ops: the chat-turn wrapper is the HOST that's
      // running this very tool call (chat-runner.ts:308 registers it
      // before the model gets its first tool call). Including it makes the
      // guard self-block — the host op blocks its own delegations and the
      // returned BLOCKED message references the host's id. Models then
      // copy-paste the id back, narrating a fake delegation. See repro at
      // tests/ops/op-submit-async-self-block.test.ts.
      const liveOps = listOpsForSession(sessionId)
        .map(id => readOp(id))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .filter(o => (o.status === "running" || o.status === "pending") && o.type !== "chat_turn");
      if (liveOps.length > 0) {
        const live = liveOps[0];
        return {
          content:
            `BLOCKED — a peer op for this session is already ${live.status} ("${live.task.slice(0, 80)}${live.task.length > 80 ? "..." : ""}"). ` +
            `END THIS TURN NOW. Tell the user briefly, in your own words, that the prior op is in flight and you'll surface it on completion. ` +
            `Do NOT quote this instruction back. Do NOT call op_submit_async again — every retry hits this same BLOCKED return. ` +
            `Do NOT call op_status as a "check first" — the user is auto-notified on completion. ` +
            `If the live op is genuinely stuck and you must terminate it, call op_kill() with no args; otherwise just end the turn.`,
          metadata: {
            chip: {
              kind: "blocked-by-op",
              label: "Prior op in flight",
              detail: live.task.slice(0, 80) + (live.task.length > 80 ? "…" : ""),
              opId: live.id,
              actions: [{ label: "Kill", tool: "op_kill", args: { op_id: live.id } }],
            },
          },
        };
      }
      // SECONDARY GUARD: 30s window catches the race where the previous
      // op JUST completed but the agent hasn't seen the completion event
      // yet and is mid-retry. Belt-and-suspenders.
      const prior = RECENT_SUBMITS.get(sessionId);
      if (prior && Date.now() - prior.ts < SUBMIT_DEDUP_WINDOW_MS) {
        const ageS = Math.round((Date.now() - prior.ts) / 1000);
        return {
          content:
            `BLOCKED — you already submitted a prior op ${ageS}s ago in this chat session ("${prior.task.slice(0, 80)}${prior.task.length > 80 ? "..." : ""}"). ` +
            `END THIS TURN NOW. Tell the user briefly, in your own words, that the work is in flight and you'll surface it on completion. ` +
            `Do NOT quote this instruction back. Do NOT call op_submit_async again — every retry this turn will hit BLOCKED. ` +
            `Do NOT call op_status — the user is auto-notified on completion. ` +
            `If you legitimately need to delegate something *different* later, that's a future turn, not this one.`,
          metadata: {
            chip: {
              kind: "blocked-by-op",
              label: `Just submitted (${ageS}s ago)`,
              detail: prior.task.slice(0, 80) + (prior.task.length > 80 ? "…" : ""),
              opId: prior.opId,
            },
          },
        };
      }
      // Casual-reply guard: if the user's last message was short/casual
      // ("yo", "hey", "ok", "thanks") AND any recent completion exists in
      // this session, block ALL op spawns — the user is acknowledging, not
      // requesting new work. Catches paraphrased re-delegations that the
      // task-similarity check misses (different phrasing, same intent).
      const { findRecentCompletionMatching, findAnyRecentCompletion } = await import("../pending-notifications.js");
      const { isLastMessageCasual } = await import("../idle-nudge.js");
      if (isLastMessageCasual(sessionId)) {
        const anyRecent = findAnyRecentCompletion(sessionId);
        if (anyRecent) {
          const ageMin = Math.round((Date.now() - anyRecent.completedAt) / 60000);
          return {
            content:
              `BLOCKED — your last user message was a short/casual reply (greeting, ack, or filler). ` +
              `A prior op completed ${ageMin} min ago in this session — the user is most likely acknowledging that, not requesting new work. ` +
              `END THIS TURN NOW. Reply conversationally — acknowledge in your own words, and surface the prior result if it's relevant. ` +
              `Do NOT quote op ids back to the user. Do NOT call op_submit_async again — retries will keep hitting BLOCKED.`,
          };
        }
      }

      // Task-similarity guard: catches re-delegations where the user message
      // was substantive but the requested task overlaps with one already
      // completed (e.g., "redo the count" hitting the same target).
      const completed = findRecentCompletionMatching(sessionId, task);
      if (completed) {
        const ageMin = Math.round((Date.now() - completed.completedAt) / 60000);
        return {
          content:
            `BLOCKED — a near-identical task already completed in this chat ${ageMin} min ago (status=${completed.status}). ` +
            `Do NOT re-spawn workers for already-completed work. The result is sitting in the BACKGROUND COMPLETIONS section of your context — read it from there. ` +
            `Surface it to the user in your own words and offer the next step.`,
          metadata: {
            chip: {
              kind: "blocked-by-op",
              label: `Already done (${ageMin}m ago)`,
              detail: `status: ${completed.status}`,
              opId: completed.opId,
            },
          },
        };
      }
    }

    const op = await buildOpFromArgs(args);

    if (sessionId) {
      trackOpForSession(op.id, sessionId, task);
      RECENT_SUBMITS.set(sessionId, { opId: op.id, ts: Date.now(), task });
    }

    // Per-op adapter selection by the op's effective provider. Provider
    // follows the op's explicit hint, falling back to settings.json. User
    // picks codex in settings → ops register CodexAdapter; otherwise the
    // lane-default AnthropicAdapter from canonical-loop-bootstrap.ts
    // serves the op.
    const opProvider = op.contextPack?.routing?.preferredProvider;
    const effectiveProvider = opProvider ?? (await readSettingsProvider());
    if (effectiveProvider === "codex") {
      const { createCodexAdapter } = await import("../../canonical-loop/index.js");
      registerAdapterForOp(op.id, () => createCodexAdapter({ sessionId: sessionId || undefined }));
    }
    canonicalLoopEntry(op, sessionId ? { sessionId } : {});

    return {
      content:
        `op ${op.id} submitted (type=${op.type}, lane=${op.lane}).\n` +
        `Running in background — you can keep responding to the user. ` +
        `The user will see a notification when it completes.\n` +
        `Inspect anytime: op_status(op_id="${op.id}")  |  block on it: op_wait(op_id="${op.id}")`,
    };
  },
};
