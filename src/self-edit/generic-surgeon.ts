/**
 * Generic (non-CLI) self_edit surgeon — the last-resort surgeon for providers
 * with no coding CLI (gemini / cerebras / ollama / local / custom) AND no other
 * CLI surgeon installed. Instead of spawning an external binary it drives LAX's
 * OWN agent loop (runAgentViaCanonical) scoped to the worktree, on whatever
 * provider the user is configured for.
 *
 * This module owns only the registry + dispatch (the worker-session pattern).
 * The runner — which closes over the server's config/secrets/tools/security —
 * is wired in at startup by server/background-jobs/self-edit-surgeon-runner.ts,
 * the one place those deps are available. Keeping the loop call behind that
 * registration boundary means self-edit/* never imports the canonical loop
 * directly (mirrors how build-app-spawn isolates subprocess primitives).
 */

export type GenericSurgeonRunner = (worktreePath: string, prompt: string, signal?: AbortSignal) => Promise<string>;

let registered: GenericSurgeonRunner | null = null;

export function registerGenericSurgeon(runner: GenericSurgeonRunner): void {
  registered = runner;
}

export function isGenericSurgeonRegistered(): boolean {
  return registered !== null;
}

export interface GenericSurgeonResult {
  ok: boolean;
  output: string;
}

/**
 * Run the in-loop surgeon against the worktree. Never throws — a missing
 * registration or a runner error is reported in the result so runSurgeon can
 * format one consistent SurgeonRun.
 */
export async function runGenericSurgeon(worktreePath: string, prompt: string, signal?: AbortSignal): Promise<GenericSurgeonResult> {
  if (!registered) {
    return { ok: false, output: "(generic surgeon unavailable — no coding CLI installed and the in-loop runner is not registered)" };
  }
  try {
    const output = await registered(worktreePath, prompt, signal);
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: `(generic surgeon error: ${(e as Error).message})` };
  }
}
