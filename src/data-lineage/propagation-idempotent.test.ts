// Lineage moved parent→child when a worker is spawned (inheritSessionLineage)
// and child→parent when it completes (pushCompletionToParent) must not come
// back as a second copy. A build lead's chat spawns a worker every fix round;
// each round trip doubled its taint and external-ingestion entries until the
// server ran out of heap mid-build (2.5 GB held by propagation,
// label-check-sol 2026-11-25).
import { describe, it, expect } from "vitest";
import { recordSensitiveRead, clearSessionTaint, getTaintSummary, propagateTaint, checkEgressTaintWithPayload } from "./index.js";
import { recordExternalIngestion, propagateExternalIngestion, clearExternalIngestion, externalContentVerdict } from "./external.js";

const SECRET = "BEGIN PRIVATE BLOB: idempotent-propagation-marker-4c2e9a-quux-zonk-data END";
const PAGE = "The recovery phrase for the vault is velvet-harbor-ninety and must never be shared with anyone at all.";

describe("lineage propagation is idempotent", () => {
  it("a parent that spawns worker after worker holds each read once, not a copy per round trip", () => {
    const lead = "idem-lead";
    recordSensitiveRead(lead, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET);
    recordExternalIngestion(lead, PAGE, "web_fetch https://vault.example/recovery");
    const workers: string[] = [];
    // 12 round trips: thousands of copies without the guard, still a clean failure.
    for (let round = 0; round < 12; round++) {
      const worker = `idem-worker-${round}`;
      workers.push(worker);
      propagateTaint(lead, worker);
      propagateExternalIngestion(lead, worker);
      propagateTaint(worker, lead);
      propagateExternalIngestion(worker, lead);
    }
    expect(getTaintSummary(lead).count).toBe(1);
    expect(getTaintSummary(workers.at(-1)!).count).toBe(1);
    // The guards still see the same bytes after all those round trips.
    expect(checkEgressTaintWithPayload(lead, `copy: ${SECRET}`).blocked).toBe(true);
    expect(externalContentVerdict(lead, `Noted: ${PAGE}`).verdict).toBe("overlap");
    for (const s of [lead, ...workers]) { clearSessionTaint(s); clearExternalIngestion(s); }
  });

  it("a worker's own new read still reaches the parent", () => {
    const lead = "idem-lead-2";
    const worker = "idem-worker-own";
    recordSensitiveRead(lead, "sensitive_file", "/a", SECRET);
    propagateTaint(lead, worker);
    recordSensitiveRead(worker, "secret", "bash:other", "another-sensitive-blob-with-enough-text-to-shingle-9f1d");
    expect(propagateTaint(worker, lead)).toBe(1);
    expect(getTaintSummary(lead).count).toBe(2);
    for (const s of [lead, worker]) clearSessionTaint(s);
  });
});
