/**
 * Assemble "the bytes going on the wire" for an outbound request — the URL,
 * body, and header values joined for secret-shape scanning, used by the
 * egress guard (src/tools/http-egress-guard.ts). The exfil analyzer scans the
 * same bytes for http_request through egressPayload
 * (src/tool-execution/egress-gates.ts).
 *
 * `includeUrl: true` keeps a secret in a GET query param (which lives in the
 * URL) in the scanned set.
 *
 * Pure leaf: no app-runtime dependencies.
 */
export function outboundPayloadParts(
  args: { url?: unknown; body?: unknown; headers?: unknown },
  opts: { includeUrl: boolean },
): string {
  const parts: string[] = [];
  if (opts.includeUrl && args.url) parts.push(String(args.url));
  if (args.body) parts.push(String(args.body));
  if (args.headers && typeof args.headers === "object") {
    for (const v of Object.values(args.headers as Record<string, unknown>)) parts.push(String(v));
  }
  return parts.join("\n");
}
