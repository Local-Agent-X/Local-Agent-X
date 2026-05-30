/**
 * Self-edit smoke suite — broad subsystem health check for the smoke gate.
 *
 * WHY: the original one-ping smoke gate POSTed /api/chat and accepted any
 * reply over 50 bytes as proof the agent works. That only proves chat
 * streams — a self_edit that breaks memory, tools, sessions, or any other
 * route sails through. This suite asserts a handful of known-good subsystem
 * endpoints respond 200 on a freshly-booted probe, so a self_edit that takes
 * down tools/sessions/health is caught before merge. Dependency-free (just
 * fetch); mirrors the request shape proven in test-suite.ts (testEndpoints).
 */

const SMOKE_ENDPOINTS: [string, string][] = [
  ["/api/health", "GET /api/health"],
  ["/api/tools/stats", "GET /api/tools/stats"],
  ["/api/sessions", "GET /api/sessions"],
];

export async function runSmokeAssertions(port: number, authToken: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  for (const [path, label] of SMOKE_ENDPOINTS) {
    if (signal?.aborted) {
      return { ok: false, detail: "aborted" };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status !== 200) {
        return { ok: false, detail: `${label} returned ${res.status}` };
      }
    } catch (e) {
      return { ok: false, detail: `${label} threw: ${(e as Error).message}` };
    }
  }
  return { ok: true, detail: `${SMOKE_ENDPOINTS.length} endpoints healthy` };
}
