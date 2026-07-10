# Independent Evaluation Remediation Campaign

Status: approved, integration verification in progress

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
- Degraded credential storage: disabled by default. The storage API has an
  explicit warning-producing option, but no shipped route, setting, or
  environment variable enables it; production provider-auth writes fail closed.

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
| B1 | 1 | Browser isolation default and migration | green | baseline |
| B2 | 5 | Remove legacy DNS navigation authority | green | baseline |
| B3 | 7 | Browser download quarantine and sensitive-page blocks | green | B2 |
| B4 | 8 | Browser-mode API and UI | green | B1 |
| B5 | 13 | Concurrent two-identity browser isolation test | green | B1, B4 |
| A1 | 2, 3 | Versioned encrypted provider credential envelope, fail-closed writes | green | baseline |
| A2 | 15 | Provider migration and privacy documentation | green | A1 |
| S1 | 4 | Effective sandbox status and unattended-host acknowledgement gate | green | baseline |
| R1 | 6 | Tool idempotency classes and retry policy | green | baseline |
| R2 | 14 | Crash/restart side-effect non-duplication tests | green | R1 |
| M1 | 9 | Memory provenance propagation and retrieval labels | green | baseline |
| M2 | 10 | Approval gate for risky external durable memory | green | M1 |
| X1 | 11 | MCP sandbox/trusted-only execution posture | green | baseline |
| X2 | 12 | Signed MCP manifests and publisher trust | green | X1 |
| W1 | 18 | Fail-closed Windows signing pipeline and verification | green | baseline |
| L1 | 19 | Strict local-only central policy, API, config, and UI | green | A1, S1, X1 |
| H1 | 16 | Split request authentication, API dispatch, static serving, app serving | green | security waves |
| C1 | 17 | Split canonical chat registration and context/tool setup | green | reliability waves |
| D1 | 20 | Prune or correct stale architectural documentation | green | all production chunks |
| I1 | all | Cross-seam contracts, full suite, build, final skeptic pass | in-flight | all unparked chunks |

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

- B1-B5: isolated-by-default browser identities, explicit continuity/shared
  modes, pinned egress, download quarantine, sensitive-page withholding, and
  real concurrent Chromium isolation coverage.
- A1-A2 and S1: encrypted credential envelopes with fail-closed recovery,
  accurate migration/privacy copy, effective sandbox reporting, and trusted
  unattended-host acknowledgement.
- R1-R2: effect-aware retries and durable crash recovery that blocks duplicate,
  concurrent, mismatched, or corrupt non-idempotent replays.
- M1-M2: provenance-preserving memory and approval-gated risky promotion.
- X1-X2: confined MCP execution, startup cleanup, signed manifests, and
  package-manager/publisher identity checks.
- L1: protected strict local-only mode across providers, background services,
  tools, connectors, embeddings, voice, MCP, bridges, and browser/network paths.
- H1, C1, and D1: request-handler and canonical-chat responsibility splits,
  corrected architecture documentation, and a source-backed stale-claim gate.
- W1: release and rolling Windows workflows require signing credentials,
  validate the exact signer and timestamp, and cannot publish unsigned output.

### Parked for user or external authority

- Provisioning Azure Trusted Signing credentials/certificate profile and
  producing a publicly trusted signed artifact, if credentials are unavailable.
- Publishing, deployment, and pushing commits.

### Failed and abandoned

None.

### Descoped

None.
