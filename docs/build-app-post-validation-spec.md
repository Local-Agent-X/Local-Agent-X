# build_app Post-Validation Loop — Spec

## Context

`build_app` is a fire-and-forget tool: agent writes files, declares "done", the user discovers the bug when they open the app. Recent example — kraken-bot was built with all market data calls hitting `https://api.kraken.com/0/public/...` directly from the browser. CORS blocks every request. The agent never tested the running page; it only knew about the **private** signing-proxy requirement (which it correctly flagged in the UI) but missed the **public** CORS issue entirely.

This is not a missing-tool problem — the agent has `browser`, `bash`, and `web_fetch`. It's a missing-workflow problem. There's no equivalent of autopilot's round-validation gate (build pass → commit) for `build_app`.

The cost of the gap: every newly-built app ships with at least one obvious load-time error that a 30-second smoke test would have caught. User finds it. User reports it. Agent goes back and fixes. Three round trips for what should be a one-shot.

The proposal: bolt a post-build smoke-test phase onto `build_app` that catches load-time JS errors, network failures, and CORS-blocked requests **before** the tool returns "done" to the agent.

## Proposed flow

```
build_app(name, prompt)
  │
  ├─ phase 1: write files (existing behavior)
  │     agent writes index.html, css, js modules
  │     manifest regenerated, app appears in sidebar
  │
  ├─ phase 2: smoke-test load (NEW)
  │     ├─ spawn headless browser (reuse existing browser tool plumbing)
  │     ├─ navigate to http://127.0.0.1:<port>/apps/<slug>/
  │     ├─ wait for window.load + 2s settle
  │     ├─ collect:
  │     │     - console.error / console.warn entries
  │     │     - failed network requests (status >= 400, CORS blocks)
  │     │     - JS exceptions
  │     │     - CSP violations
  │     └─ classify findings:
  │           CRITICAL: page didn't render, JS exception on load,
  │                     all-network-failed
  │           HIGH:     CORS errors on first-party-looking requests
  │                     (api.kraken.com when /api/kraken/ proxy exists)
  │           LOW:      deprecation warnings, third-party CSP noise
  │
  ├─ phase 3: feedback to agent (NEW)
  │     If CRITICAL or HIGH findings:
  │       Return { ok: false, findings: [...], suggestion: "..." }
  │       Agent gets a structured fix prompt, runs ONE more edit pass.
  │       After the fix pass, smoke-test runs again (max 2 retry rounds).
  │     If only LOW or none:
  │       Return { ok: true, findings: [...] }
  │       Tool reports success; agent moves on.
  │
  └─ phase 4: report to user (existing behavior)
        Final message includes "smoke-tested ✓" or "smoke-test found N issues, fixed N-1, 1 known limitation" so user knows the app actually loaded.
```

## Implementation sketch

```
src/tools/builder-tools.ts                          (touch — existing buildAppTool)
src/builder/post-validation.ts                      (new ~150 LOC)

// post-validation.ts
export async function smokeTestApp(opts: {
  appSlug: string;
  port: number;
  authToken: string;
  timeoutMs?: number;       // default 15000
}): Promise<SmokeTestResult>;

interface SmokeTestResult {
  ok: boolean;
  loaded: boolean;          // did the page actually render?
  findings: Finding[];
  rawConsole: string[];     // first 50 entries for agent context
}

interface Finding {
  severity: "critical" | "high" | "low";
  category: "console-error" | "network" | "cors" | "csp" | "exception";
  message: string;
  detail?: string;          // url for network, stack for exception
  hint?: string;            // suggested fix when pattern is recognizable
}
```

### Heuristics for `hint` generation (the auto-fix lever)

Pattern-match findings against known fix templates. Examples:

| Pattern | Hint |
|---|---|
| CORS error on `https://api.<vendor>.com/...` AND repo has `/api/<vendor>/` proxy route | "Replace direct vendor API calls with the local proxy at `/api/<vendor>/...`. See `src/routes/<vendor>-proxy.ts`." |
| `Cannot read properties of null (reading 'addEventListener')` | "Element selector failed. Wrap in `DOMContentLoaded` listener or move script to bottom of `<body>`." |
| `Mixed content: page loaded over HTTPS but requested HTTP` | "Use protocol-relative or HTTPS URLs." |
| `404 GET /apps/<slug>/<missing-file>` | "File referenced in HTML/JS doesn't exist on disk. Check spelling or write the file." |
| CSP violation `script-src 'self' 'unsafe-inline'` blocking external script | "Inline the script content or add an explicit nonce." |

The hint feeds directly into the agent's fix-up round prompt — agent sees the structured finding + a starting suggestion, doesn't have to re-derive the diagnosis.

## Reusing existing infrastructure

- **Browser tool** (`src/browser-tools.ts`) already wraps a headless browser. We can call its internal navigation + console-capture path directly from post-validation.ts without going through the agent tool layer (no API call overhead).
- **Auth token** — `build_app` already runs server-side; it has `config.authToken` in scope. The smoke test loads `/apps/<slug>/?token=<authToken>` so the page can hit auth-protected proxies during validation.
- **Manifest entry** — already created in phase 1, so the smoke test can resolve `appSlug` → URL via the same path the user does.

## Hard caps

- **Smoke test timeout**: 15s (default), configurable. After timeout → finding `severity: critical, category: load-timeout`.
- **Fix-up rounds**: max 2. If second round still has CRITICAL findings, return ok:false but stop retrying — agent reports the unresolved issue to the user.
- **Per-build budget**: total `build_app` time cap of 10 min including all smoke + fix rounds. Prevents runaway loops.

## What's intentionally out of scope

- **Full E2E testing.** This is a load-time smoke test, not a feature test. We're not clicking buttons, filling forms, or asserting behavior — just "did it load without obvious errors?"
- **Performance auditing.** No Lighthouse scores, bundle-size checks, etc. v2 if useful.
- **Visual regression.** No screenshot comparison against a reference. Out of scope for now.
- **Sub-agent for smoke-test.** Keep it in-process — sub-agent overhead isn't worth it for a 15s smoke check.

## Verification (how to test the spec)

1. Build a test app that deliberately calls `https://api.kraken.com/0/public/Time` from browser JS. Without post-validation: returns ok. With post-validation: returns `ok: false` with a CORS finding pointing at `/api/kraken/public/Time` proxy.
2. Build an app that misses a required file (HTML references `js/missing.js` that wasn't written). Smoke test catches the 404 in network log → finding → agent gets a hint, writes the missing file in fix-up round → second smoke test passes.
3. Build an app that uses an undeclared variable (`onclick="doStuff()"` but `doStuff` is never defined). Smoke test catches the JS exception on click — wait, this is a click handler, not load-time. Out of scope for v1; document as known limitation. Agent should still ship a sane code structure that doesn't have load-time exceptions.
4. Build a clean app with no errors. Smoke test returns ok:true with empty findings, agent declares done in one shot.

## Estimated work

| Task | LOC est | Time est |
|---|---|---|
| `src/builder/post-validation.ts` (smoke-test orchestrator) | 150 | 2h |
| Heuristic library (CORS-with-known-proxy detector, etc.) | 80 | 1h |
| Wire into `buildAppTool` in `src/tools/builder-tools.ts` | 30 | 30m |
| Browser plumbing reuse (call internal nav + console capture) | 50 | 1h |
| Fix-up round prompt template | 20 | 30m |
| Smoke tests + manual verification (the four scenarios above) | — | 1h |
| **Total** | **~330 LOC** | **~6h** |

Stays well under 400-LOC limit per file; orchestrator + heuristics split into two files.

## Why this matters beyond build_app

Same shape (build → validate → fix loop) generalizes to:
- `protocol_run` — execute, check for "this didn't work" patterns in output
- Cron mission output — already partially done via the recent refusal/topic-match validators
- Future code-edit autopilot rounds — already done via build-passes gate

Once the post-validation pattern is proven on `build_app`, lifting it into a generic "tool result self-validation" wrapper that other tools can opt into is a natural follow-up.
