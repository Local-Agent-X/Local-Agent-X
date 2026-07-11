/**
 * Assemble "the bytes going on the wire" for an outbound request — the URL,
 * body, and header values joined for secret-shape scanning. Shared by the
 * exfil analyzer (src/threat/tool-chain.ts) and the egress guard
 * (src/tools/http-egress-guard.ts) so both scan the SAME byte set.
 *
 * The `includeUrl` flag is the only difference between the two consumers:
 *   - The exfil analyzer passes `includeUrl: true` so a secret in a GET query
 *     param (which lives in the URL) is still seen.
 *   - The egress guard passes `includeUrl: false` because by the time it builds
 *     this set, GET/HEAD/OPTIONS have already short-circuited — only methods
 *     that carry a body remain, so the URL adds nothing to scan.
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
