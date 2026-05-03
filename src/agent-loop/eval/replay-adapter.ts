/**
 * Replay adapter — yields pre-canned StreamChunks instead of calling a
 * real model. Lets eval fixtures pin behavior without burning tokens
 * or introducing model nondeterminism into the loop tests.
 *
 * Registered as `replay-http` in the registry. The runner hands each
 * fixture's response sequence to setReplayResponses() before running,
 * then resets between variants.
 *
 * Single global state — the eval runner is single-threaded, so this is
 * safe. If we ever need parallel fixture runs, swap to a per-instance
 * state via a unique adapter name per run.
 */

import { BaseAdapter, registerAdapter } from "../../providers/adapter/index.js";
import type {
  ProviderRequest,
  StreamChunk,
} from "../../providers/adapter/types.js";

let _responses: StreamChunk[][] = [];
let _iteration = 0;

export function setReplayResponses(seqs: StreamChunk[][]): void {
  _responses = seqs;
  _iteration = 0;
}

export function resetReplayState(): void {
  _responses = [];
  _iteration = 0;
}

export function getReplayIteration(): number {
  return _iteration;
}

class ReplayAdapter extends BaseAdapter {
  readonly name = "replay-http";

  async *stream(_req: ProviderRequest): AsyncIterable<StreamChunk> {
    const seq = _responses[_iteration];
    _iteration += 1;
    if (!seq) {
      yield {
        type: "error",
        message: `replay adapter exhausted at iteration ${_iteration - 1} (fixture provided ${_responses.length} response sequences)`,
      };
      return;
    }
    for (const chunk of seq) {
      yield chunk;
    }
  }
}

export const replayAdapter = new ReplayAdapter();

let _registered = false;
export function ensureReplayAdapterRegistered(): void {
  if (_registered) return;
  _registered = true;
  try {
    registerAdapter(replayAdapter);
  } catch {
    // Already registered (e.g., re-import in the same process). Ignore.
  }
}
