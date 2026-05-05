# canonical-loop soak telemetry — read side

Soak metrics land at `workspace/canonical-loop-soak.jsonl`, one JSON
line per terminated canonical-loop op. Append-only. The file is
auto-created on the first event; `workspace/*` is gitignored, so
nothing leaks into the repo.

The sink is wired into `src/canonical-loop/event-emitter.ts` —
passive observer at the `emit()` and `publishStreamChunk()` seams.
Pure instrumentation: never throws, never blocks, never modifies
adapter or loop behavior. Disable without a deploy by setting:

```
CANONICAL_LOOP_SOAK=0   # also accepts: false, no, off
```

Default is ON.

---

## Per-line schema

| Field | Type | Notes |
|---|---|---|
| `opId` | string | |
| `provider` | string \| null | From `op.contextPack.routing.preferredProvider` at terminal time. Null when not set. |
| `lane` | string | One of `interactive` / `build` / `ide` / `background`. |
| `startedAt` | ISO 8601 | First time we observed `state_changed null→queued` for this op. |
| `finishedAt` | ISO 8601 | When the terminal `state_changed` landed. |
| `durationMs` | number | `finishedAt - startedAt`. |
| `terminal` | string | `succeeded` \| `failed` \| `cancelled`. |
| `failureClass` | string \| null | `null` on success. Otherwise: `abort` (cancel), `timeout`, `parse_error`, `provider_error`, `crash_recovery`, `unknown`, or the raw `error.code` if it doesn't match a known pattern. |
| `rounds` | number | Count of `turn_committed` events observed. |
| `firstContentLatencyMs` | number \| null | `startedAt` → first stream chunk OR first finalized assistant message, whichever arrives first. |
| `usageInputTokens` | number \| null | Best-effort from latest `op_turn.providerState.providerPayload.usageInputTokens`. |
| `usageOutputTokens` | number \| null | Same, output side. |
| `crashRecovered` | boolean | `true` if `lease_lost reason="expired"` was observed during the op's lifetime. |

---

## Daily roll-up (one-shot bash + jq)

```bash
LOG=workspace/canonical-loop-soak.jsonl
TODAY=$(date +%Y-%m-%d)

jq -s --arg day "$TODAY" '
  map(select(.startedAt | startswith($day))) as $today
  | {
      day: $day,
      total: ($today | length),
      succeeded: ($today | map(select(.terminal == "succeeded")) | length),
      failed: ($today | map(select(.terminal == "failed")) | length),
      cancelled: ($today | map(select(.terminal == "cancelled")) | length),
      failureRatePct: (
        if ($today | length) == 0 then 0
        else (($today | map(select(.terminal != "succeeded")) | length) / ($today | length) * 100)
        end
      ),
      p50DurationMs: (
        ($today | map(.durationMs) | sort) as $d
        | if ($d | length) == 0 then null else $d[($d | length / 2 | floor)] end
      ),
      p95DurationMs: (
        ($today | map(.durationMs) | sort) as $d
        | if ($d | length) == 0 then null else $d[((($d | length) - 1) * 0.95 | floor)] end
      ),
      crashRecoveryCount: ($today | map(select(.crashRecovered)) | length),
      failureClassBreakdown: (
        $today | map(select(.failureClass != null))
        | group_by(.failureClass)
        | map({(.[0].failureClass): length})
        | add // {}
      )
    }
' "$LOG"
```

PowerShell equivalent (uses `jq` if installed, otherwise falls back
to ConvertFrom-Json):

```powershell
$today = (Get-Date -Format "yyyy-MM-dd")
$rows = Get-Content workspace/canonical-loop-soak.jsonl |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.startedAt.StartsWith($today) }

[PSCustomObject]@{
  day                = $today
  total              = $rows.Count
  succeeded          = ($rows | Where-Object terminal -eq succeeded).Count
  failed             = ($rows | Where-Object terminal -eq failed).Count
  cancelled          = ($rows | Where-Object terminal -eq cancelled).Count
  failureRatePct     = if ($rows.Count -eq 0) { 0 } else {
                        [math]::Round(($rows | Where-Object terminal -ne succeeded).Count / $rows.Count * 100, 2)
                      }
  p50DurationMs      = ($rows.durationMs | Sort-Object)[[math]::Floor($rows.Count / 2)]
  p95DurationMs      = ($rows.durationMs | Sort-Object)[[math]::Floor(($rows.Count - 1) * 0.95)]
  crashRecoveryCount = ($rows | Where-Object crashRecovered -eq $true).Count
}
$rows | Where-Object failureClass | Group-Object failureClass |
  Select-Object Name, Count | Format-Table -AutoSize
```

---

## Gate-clean criteria for v1.1 implementation start

Apply over a rolling 7-day window:

- `failureRatePct` < 1
- `crashRecoveryCount` == 0 (any > 0 deserves a look — Issue 16
  pre-stream cancel hang or something new)
- `p95DurationMs` not climbing across days (no slow regression)
- `failureClassBreakdown` free of `provider_error` / `parse_error`
  spikes (single noisy day under 5 is fine; sustained pattern is
  not)
- No flag-OFF deployments observed (canary stayed enabled)

When all five hold for 7 consecutive days starting from the first
v1.0 canary day with real interactive traffic, v1.1 implementation
unblocks.

---

## Known limitations / not captured

- **`usageInputTokens` / `usageOutputTokens`** are populated only
  when the adapter records usage in `provider_state.providerPayload`.
  The Anthropic v1.0 adapter does not. Codex v1.1 will. Don't gate
  on token volume yet.
- **`firstContentLatencyMs`** measures wall time from op submission
  to first stream chunk OR first finalized assistant message. It
  includes lease acquisition + scheduler latency, so it's "user-
  visible time to first byte," not pure model latency.
- **In-process record loss.** If the host crashes mid-op, the
  in-flight metric record is lost (the JSONL line is only written
  at op terminal). On a re-leased recovery the new worker's
  `state_changed` will look like a fresh op to the sink, with
  `crashRecovered=false` (because the original sink instance is
  gone). Acceptable for canary observability — the fact that a
  recovery happened is still visible in `op_events` directly.
- **Per-turn detail.** The sink only emits per-op summaries. Per-
  turn timing / per-turn tool counts are not surfaced. Drop down
  into `op_events.jsonl` for that detail when investigating a
  specific opId.
- **Cross-host aggregation.** The JSONL is per-host. If you ever
  run multiple hosts, copy and concat before running the roll-up.
