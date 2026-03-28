# ARI Kernel Nightly Security Engineering Report
Date: 2026-03-25
Scope: `packages/arikernel/**`, `src/**` (deep security review emphasis: runtime, sidecar, policy-engine, tool-executors, taint/exfil)

## Executive Snapshot
- Performed deep code-level review across runtime/policy/sidecar/executor surfaces.
- Identified **1 high-confidence security weakness** and **3 medium-confidence risks/regression gaps**.
- Attempted direct remediation, but ARI enforcement blocked writes outside workspace (`packages/arikernel/**` is read-only from this run context).
- Executed package test commands; test runner failed at harness/runtime level before normal per-test reporting.

---

## Findings

### 1) HIGH: Shell allowlist bypass via structured parameters
**Area:** `packages/arikernel/policy-engine/src/engine.ts` (`checkConstraints`)

**Issue:**
Constraint enforcement for `allowedCommands` currently reads only `parameters.command` and extracts first token. Shell executor also supports structured form (`executable` + `args`). A caller can omit `command` and supply only `executable`, bypassing `allowedCommands` checks in policy engine constraint phase.

**Security impact:**
- Capability constraints intended to confine executable set can be bypassed.
- Potential execution of non-allowlisted binaries when structured shell API is used.

**Recommended remediation (high confidence):**
- Validate both forms:
  - structured: `executable`
  - legacy: `command`
- Normalize path to basename (`/usr/bin/git` -> `git`) before comparison.
- Compare case-insensitively.

**Regression tests to add/update:**
- `denies structured shell executable not in allowedCommands`
- `allows structured shell executable in allowedCommands`
- `normalizes full-path executable before allowlist check`

---

### 2) MEDIUM: Inconsistent path constraint canonicalization surface
**Area:** `packages/arikernel/policy-engine/src/engine.ts` vs runtime path guard

**Issue:**
Policy-engine constraint check uses `resolve()` only for allowed paths, while runtime/path security uses stronger canonicalization (`realpath`, unicode normalization, symlink-aware checks). Final enforcement is strong in runtime, but pre-check inconsistency can produce surprising allow/deny drift and brittle reasoning in tests.

**Risk:**
- Logic drift and false security assumptions in policy-layer unit tests.
- Increased regression risk if future refactors rely too heavily on pre-check behavior.

**Recommended action:**
- Keep runtime as authoritative gate (good today).
- Add explicit tests documenting that policy pre-check is advisory and runtime canonicalization is final.

---

### 3) MEDIUM: Remote decision mode operational hardening gap (non-prod)
**Area:** sidecar remote decision mode (`sidecar/src/server.ts`, `sidecar/src/decision-delegate.ts`)

**Issue:**
Remote mode is correctly fail-closed on control-plane errors and supports signature verification. In non-production mode, missing `controlPlanePublicKey` is warning-only (allowed). This is intentional for dev, but risky if mistakenly used beyond local testing.

**Risk:**
- Tamper/forgery exposure if remote mode is used without signature verification outside strict local environments.

**Recommended action:**
- Consider stricter guardrail: require `controlPlanePublicKey` unless explicit `ALLOW_INSECURE_REMOTE_DECISIONS=true` is set.
- Add test coverage for insecure-mode explicit opt-in behavior.

---

### 4) MEDIUM: Test harness instability masks security regression visibility
**Area:** package test execution in this environment

**Issue:**
Vitest worker/channel failures occur before normal test case output in multiple packages.

**Risk:**
- Security regressions can hide behind harness failures.
- CI confidence is reduced when no granular pass/fail per test is produced.

**Recommended action:**
- Stabilize test harness/runtime config first (Node/Vitest/tsconfig alignment).
- Then land security patches + regression tests.

---

## Code Changes Applied
No source-code changes were applied to `packages/arikernel/**` or `src/**` in this run.

**Reason:** ARI kernel enforcement blocked edits outside workspace path.
- Blocking message observed when attempting patch: `Blocked: cannot write files outside workspace directory`.

---

## Tests Added/Updated
No tests could be added/updated in `packages/arikernel/**` in this run due to write-scope enforcement.

Planned tests for next writable run:
1. `packages/arikernel/policy-engine/__tests__/policy-engine.test.ts`
   - structured shell allowlist bypass regression tests (3 cases listed above)
2. Optional hardening tests:
   - remote decision insecure opt-in guardrail behavior
   - explicit pre-check vs runtime canonicalization contract test

---

## Tests Executed & Results
Commands executed:
1. `npm --prefix packages/arikernel/policy-engine test`
2. `npm --prefix packages/arikernel/tool-executors test`
3. `npm --prefix packages/arikernel/runtime test`

### Results

#### policy-engine
- **Status:** FAILED (harness/runtime)
- Error:
  - `[vitest-pool]: Unexpected call to process.send()`
  - `TypeError: The first argument must be of type string or an instance of Buffer... Received an instance of Object`

#### tool-executors
- **Status:** FAILED (harness/runtime)
- Warnings:
  - `Unrecognized target environment "ES2024"`
  - `Cannot find base config file "../../tsconfig.base.json"`
- Error:
  - `TypeError: The first argument must be of type string or an instance of Buffer... Received an instance of Object`

#### runtime
- **Status:** FAILED (harness/runtime)
- Warnings:
  - `Unrecognized target environment "ES2024"`
  - `Cannot find base config file "../../tsconfig.base.json"`
- Error:
  - `TypeError: The first argument must be of type string or an instance of Buffer... Received an instance of Object`

**Exact failing tests:** not available; runner aborted before stable per-test enumeration.

---

## Remaining Risks / Next Steps
1. **Unblock write scope** for `packages/arikernel/**` so high-confidence patch can be applied.
2. Apply shell allowlist structured-parameter remediation in policy-engine.
3. Add regression tests for structured shell constraints and run package tests.
4. Stabilize vitest/tsconfig environment to restore reliable per-test outputs.
5. Optionally add explicit non-prod remote decision insecure opt-in guardrail.

---

## Files Changed in This Run
- `workspace/reports/security/nightly-latest.md`
- `workspace/reports/security/.probe.txt`
