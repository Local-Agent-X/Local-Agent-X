/**
 * SSE (Server-Sent Events) parser — line-buffered, generic. Used by
 * Anthropic HTTP streams and any future raw-fetch provider.
 *
 * Yields each `data: ...` payload as a string. Empty lines, comments
 * (`:`-prefixed), and the SSE `[DONE]` sentinel are filtered out. The
 * caller is responsible for JSON.parse on each yielded payload — keeping
 * this layer payload-agnostic means it works for any text/event-stream
 * source regardless of the inner schema.
 *
 * Pattern: read once, buffer between events on `\n\n`, split each event
 * on `\n`, yield only `data:` lines.
 */

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          yield data;
        }
      }
    }
    // Flush any trailing buffered event (no terminating \n\n).
    if (buffer) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        yield data;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
