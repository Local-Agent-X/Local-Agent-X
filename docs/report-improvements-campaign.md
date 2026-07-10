# Independent Evaluation Remediation Campaign

Status: approved, in progress

## Objective

Complete or conclusively disposition all 20 prioritized recommendations from
the July 2026 independent technical evaluation without replacing the canonical
loop, bypassing central tool execution, controlling the user's everyday browser
profile, or auto-injecting cross-session memory.

## Approved Product Semantics

- `isolated`: default; each session receives a separate ephemeral browser identity.
- `continuity`: an explicitly selected persistent dedicated browser identity.
- `advanced-shared`: an explicitly selected live context shared across sessions.
- Strict local-only: only loopback network access and local models; cloud
  providers, OAuth, brokers, connectors, remote MCP, and internet browser/tool
  egress are blocked.
- Degraded credential storage: disabled by default and available only after an
  explicit warning and acknowledgement.

## Invariants

- Tool effects continue through the canonical tool-execution pipeline.
- Browser navigation remains fail-closed through one canonical request guard.
- Existing dedicated agent browser profiles remain separate from user profiles.
- Secrets never enter logs, tool results, source, or unencrypted storage silently.
- Every production chunk includes behavioral regression coverage.
- A chunk is green only after independent refutation fails to break it.
- No campaign commit is pushed or deployed.

## Chunk Ledger

| ID | Report | Responsibility | State | Dependencies |
| --- | --- | --- | --- | --- |
| B1 | 1 | Browser isolation default and migration | pending | baseline |
| B2 | 5 | Remove legacy DNS navigation authority | pending | baseline |
| B3 | 7 | Browser download quarantine and sensitive-page blocks | pending | B2 |
| B4 | 8 | Browser-mode API and UI | pending | B1 |
| B5 | 13 | Concurrent two-identity browser isolation test | pending | B1, B4 |
| A1 | 2, 3 | Versioned encrypted provider credential envelope, fail-closed writes | pending | baseline |
| A2 | 15 | Provider migration and privacy documentation | pending | A1 |
| S1 | 4 | Effective sandbox status and unattended-host acknowledgement gate | pending | baseline |
| R1 | 6 | Tool idempotency classes and retry policy | pending | baseline |
| R2 | 14 | Crash/restart side-effect non-duplication tests | pending | R1 |
| M1 | 9 | Memory provenance propagation and retrieval labels | pending | baseline |
| M2 | 10 | Approval gate for risky external durable memory | pending | M1 |
| X1 | 11 | MCP sandbox/trusted-only execution posture | pending | baseline |
| X2 | 12 | Signed MCP manifests and publisher trust | pending | X1 |
| W1 | 18 | Fail-closed Windows signing pipeline and verification | pending | baseline |
| L1 | 19 | Strict local-only central policy, API, config, and UI | pending | A1, S1, X1 |
| H1 | 16 | Split request authentication, API dispatch, static serving, app serving | pending | security waves |
| C1 | 17 | Split canonical chat registration and context/tool setup | pending | reliability waves |
| D1 | 20 | Prune or correct stale architectural documentation | pending | all production chunks |
| I1 | all | Cross-seam contracts, full suite, build, final skeptic pass | pending | all unparked chunks |

## Conflict Magnets

- `src/config-schema.ts`: B1, B4, S1, A1, L1 serialize.
- `public/app.html`: B4, S1, X1, L1, A2 serialize.
- `src/tool-execution/run-sandboxed.ts`: S1 and R1 serialize.
- `src/auth/`: A1 lands before A2 and L1.
- `src/mcp-client/`: X1 lands before X2 and L1.
- Canonical-loop and request-handler refactors run only after behavioral
  security and reliability contracts are green.

## Execution Waves

1. Baseline, B2, M1, W1, and independent contract reconnaissance.
2. B1/B3/B4/B5, A1/A2, S1/R1/R2 in dependency pipelines.
3. M2 and X1/X2.
4. L1 behind the shared-config risk gate.
5. H1 and C1 behind the behavioral-contract gate.
6. D1 and I1.

## Completion Accounting

### Shipped (green)

Pending.

### Parked for user or external authority

- Provisioning Azure Trusted Signing credentials/certificate profile and
  producing a publicly trusted signed artifact, if credentials are unavailable.
- Publishing, deployment, and pushing commits.

### Failed and abandoned

None.

### Descoped

None.
