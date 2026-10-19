# browser

**Owns:** The agent's browser: two backends behind one `BrowserBackend` contract — the embedded in-app WebContentsView (default) and external Chrome over CDP — plus routing between them, observation and extraction, downloads, egress taint, and secret fill/capture.
**Does not own:** The `browser` tool's schema and action handlers → `src/tools/browser-tools/`; the desktop-side view host → `desktop/src/browser-views.ts`; URL egress policy → `src/security/layer/network-policy.ts`.
**Entry:** `index.ts` — `getBrowserManager(sessionId)` (the routed backend), `getSecretBrowserOps`, `BrowserManager`, `withBrowserLock`, the session-owner registry. The routing decision is `resolveBrowserRoute()` in `route-resolve.ts` (re-exported by `instance.ts`).

## Invariants
- `browserMode` defaults to `in-app` (`src/config-schema.ts`). `resolveBrowserRoute()` is the one fallback matrix: a non-`in-app` mode, `LAX_BROWSER_HEADLESS=1`, or no desktop bridge routes to CDP and says why. Don't add a second routing decision.
- Both backends implement every `BrowserBackend` method; tool-layer security (sensitive-page guards, download approval, egress taint, mutex) sits above the interface and stays backend-agnostic.
- Secret values touch a page only through `SecretBrowserOps` (`secret-ops.ts`): credential-field selectors, exact origin binding, first-use approval — never via `fill()` / `evaluate()`, which echo page content back to the model.
- Every mode uses an agent-owned profile, never the user's own browser profile. Which agent-owned profile is the session's registered `browserProfile` (`session-owner-registry.ts` `resolveBrowserProfile`): the shared signed-in one by default; a scheduled job's run gets the job's own (in-app: the partition `jobBrowserPartition` names on the lifecycle `create`; CDP: a dedicated Chrome on `jobBrowserProfileDir`, under the data dir) unless the user set `useSignedInBrowser` on the job. `instance.ts` is the one place that applies it.
- A job's own profile is wiped only by `clearJobBrowserProfile` (`job-browser-profile.ts`), for the Missions page's "Clear sign-ins" (`POST /api/cron/:id/clear-sign-ins`) and for every job delete (`CronService.delete`). It holds the profile shut for the wipe, closes the job's live browsers (`closeJobProfileBrowsers` in `instance.ts`) and waits out any Chrome still on the dir (`stopChromesOnProfileDir`: mid-launch, or mid-close by another caller), then removes the profile dir — refusing any path that is not exactly one entry under `browser-job-profiles` — and clears the partition over the desktop bridge (`lax:browser-clear-partition`). It never names the signed-in profile. A deleted job's profile stays shut for good: `jobBrowserProfileOpen` (the server's `setJobExistsCheck`) is checked when a backend is minted on it and when its Chrome launches, so a run its delete aborted cannot write the dir back.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `backend.ts` | `in-app-backend.ts`, `manager.ts`, `src/tools/browser-tools/` | `backend-conformance.test.ts` |
| `route-resolve.ts` / `instance.ts` | `emulation-route.ts`, `src/desktop-bridge.ts` | `instance-routing.test.ts`, `emulate-in-app-route.test.ts` |
| `secret-ops.ts` | `secret-fill.ts`, `secret-capture.ts`, `src/tools/browser-tools/index.ts` | `secret-ops.test.ts`, `secret-fill.test.ts`, `secret-capture.test.ts` |
| `runtime.ts` (the shared Chrome process) | `launcher.ts`, `continuity-cache.ts` | `continuity-persistence.test.ts` |
| `bridge-client.ts` | `desktop/src/browser-views.ts`, `bridge-client-contract.ts` | `bridge-client.test.ts` |
| `job-browser-profile.ts` / `session-owner-registry.ts` job paths | `src/cron/cron-service.ts` (`delete`), `src/routes/bridges/cron.ts` | `job-browser-profile.test.ts`, `job-profile-delete-race.test.ts`, `test/cron-service.test.ts`, `src/routes/bridges/cron-agent.test.ts` |

## Tests
`npx vitest run src/browser` (PowerShell on Windows)
