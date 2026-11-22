/**
 * One finished text from a streaming provider client, for a short side call.
 *
 * Every side call that reads a stream instead of a single HTTP response goes
 * through here: llm-dispatch's own Anthropic-subscription and Codex legs
 * (hosted.ts) and the classifiers' (classifiers/classify-with-llm-dispatch.ts).
 * Each of the four kept its own read loop, and they disagreed on the one rule
 * that matters: a reply that did not finish is no reply. An Anthropic auth
 * error was once accepted as a compaction summary and saved over real history;
 * the Anthropic loops learned to throw, the Codex loops never did, and kept
 * returning whatever text had arrived when the stream closed.
 *
 * Both functions throw when there is no finished reply, so the caller falls
 * back as it does for any failed call. Stopping at `maxChars` is the caller's
 * own cut, not a failure: the text so far is the answer.
 */

export interface StreamTextOptions {
  /** Stop reading once this many characters have arrived. */
  maxChars?: number;
  /** The call's own abort signal: a stream that closed because the caller ran
   *  out of time is reported as aborted, not as a provider fault. */
  signal?: AbortSignal;
}

interface AnthropicTextEvent { type: string; delta?: string; error?: string }
interface CodexTextEvent { type: string; delta?: string; stopReason?: string }

/** The Anthropic client reports a failed or cut request as an `error` event
 *  (the CLI's "Please run /login", a dropped connection). */
export async function anthropicStreamText(stream: AsyncIterable<AnthropicTextEvent>, opts: StreamTextOptions = {}): Promise<string> {
  let text = "";
  for await (const event of stream) {
    if (event.type === "error") throw new Error(event.error || "anthropic transport error");
    if (event.type === "text") text += event.delta || "";
    if (opts.maxChars !== undefined && text.length >= opts.maxChars) break;
  }
  return text;
}

/**
 * The Codex client throws on a refused request but ends a stream that closed
 * early (a dropped connection, its silence timer, an abort) the same way it
 * ends a finished one. The difference is the `done` event's `stopReason`,
 * which the API's terminal event sets and nothing else does; the chat adapter
 * reads it the same way (providers/adapters/codex-cli.ts).
 */
export async function codexStreamText(stream: AsyncIterable<CodexTextEvent>, opts: StreamTextOptions = {}): Promise<string> {
  let text = "";
  let finished = false;
  for await (const event of stream) {
    if (event.type === "text") text += event.delta || "";
    if (event.type === "done") finished = event.stopReason !== undefined;
    if (opts.maxChars !== undefined && text.length >= opts.maxChars) return text;
  }
  if (!finished) {
    throw new Error(opts.signal?.aborted ? "codex call aborted" : "codex stream closed before the reply finished");
  }
  return text;
}
