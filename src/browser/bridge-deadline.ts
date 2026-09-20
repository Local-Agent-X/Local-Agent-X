/**
 * One deadline for all the bridge ops a single browser ACTION issues.
 *
 * The bug this closes (live 2026-09-20, op_chat_turn_b3b9433fdd47422a):
 * `browser {action:"screenshot"}` took 31.9s and came back "browser capture
 * timed out after 10000ms". Both numbers were true. One screenshot issues a
 * SEQUENCE of bridge ops — ensureView's lifecycle calls, the credential-focus
 * exec, then the capture — and each carries its own fixed timeout from
 * bridge-client-contract.ts. Every one of those is comfortably under the
 * browser tool's 30s budget on its own; their SUM is not, and nothing bounded
 * the sum. So the tool blew its budget, the innermost rejection won the race,
 * and the model was handed a number (10s) that described neither the wait it
 * had just paid nor the reason. It read that as a transient hiccup, retried,
 * and burned another 31.8s for the same answer.
 *
 * Fixing the one constant would not have helped: raising the capture ceiling
 * lengthens the sequence, and lowering it just moves which op reports. The
 * missing thing is a budget the ops share. The action opens a scope here, and
 * every op clamps its own timeout to what is left of it.
 *
 * Time the user spends deciding an approval card is NOT the tool working, so
 * it extends the deadline exactly as it extends the tool timeout — otherwise
 * this would re-create the fight tool-timeout.ts's `excludedMs` settled.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { currentApprovalWaitMs } from "../approval-wait.js";

interface DeadlineScope {
	/** Monotonic ms budget, measured from `startedAt`. */
	budgetMs: number;
	startedAt: number;
	/** Approval time already excluded when the scope opened, so only waiting
	 *  that happened INSIDE this action buys it extra wall clock. */
	approvalMsAtStart: number;
	label: string;
}

const scope = new AsyncLocalStorage<DeadlineScope>();

/**
 * Run one tool action under a shared bridge budget. `label` names the action
 * for the error the model reads. Nested scopes keep the outer deadline: the
 * outermost caller owns the tool's budget.
 */
export function withBridgeDeadline<T>(budgetMs: number, label: string, fn: () => Promise<T>): Promise<T> {
	if (scope.getStore() || budgetMs <= 0) return fn();
	return scope.run(
		{ budgetMs, startedAt: Date.now(), approvalMsAtStart: currentApprovalWaitMs(), label },
		fn,
	);
}

/** Milliseconds left in the action's budget, or null when no scope is open
 *  (a bridge call outside a tool action keeps its own fixed timeout). */
export function bridgeRemainingMs(): number | null {
	const store = scope.getStore();
	if (!store) return null;
	const approvalInScope = currentApprovalWaitMs() - store.approvalMsAtStart;
	return store.startedAt + store.budgetMs + approvalInScope - Date.now();
}

/** The open scope's label, for error text. */
export function bridgeDeadlineLabel(): string | null {
	return scope.getStore()?.label ?? null;
}

/** How long the action has been running — the number the model should see,
 *  rather than one op's ceiling. 0 when no scope is open. */
export function bridgeElapsedMs(): number {
	const store = scope.getStore();
	return store ? Date.now() - store.startedAt : 0;
}
