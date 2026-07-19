import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCertificationStore } from "./certification-store.js";
import { CERTIFICATION_SCENARIOS, type LocalModelCertification } from "./certification-types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function certification(hash: string): LocalModelCertification {
  const scenarios = Object.fromEntries(CERTIFICATION_SCENARIOS.map((id) => [id, {
    passed: true,
    calls: 1,
    latencyMs: 2,
    failure: null,
  }])) as LocalModelCertification["scenarios"];
  return {
    version: 1,
    fingerprint: { hash, reusable: true },
    scenarios,
    passedCount: 5,
    callCount: 5,
    totalLatencyMs: 10,
  };
}

function tempStore(): { file: string; store: LocalCertificationStore } {
  const dir = mkdtempSync(join(tmpdir(), "lax-cert-adversarial-"));
  dirs.push(dir);
  const file = join(dir, "certifications.json");
  return { file, store: new LocalCertificationStore(file) };
}

describe("LocalCertificationStore validation and bounds", () => {
  it("rejects an entry whose inner fingerprint does not match its lookup key", () => {
    const { file, store } = tempStore();
    const outer = "a".repeat(64);
    const inner = "b".repeat(64);
    writeFileSync(file, JSON.stringify({ version: 1, entries: { [outer]: certification(inner) } }));
    expect(store.read(outer)).toBeNull();
  });

  it("rejects inconsistent aggregate counts and pass/failure pairs", () => {
    const hash = "c".repeat(64);
    for (const mutate of [
      (value: LocalModelCertification) => { value.passedCount = 4; },
      (value: LocalModelCertification) => { value.callCount = 4; },
      (value: LocalModelCertification) => { value.totalLatencyMs = 9; },
      (value: LocalModelCertification) => {
        value.scenarios.baseline_marker.failure = "missing_marker";
      },
    ]) {
      const { file, store } = tempStore();
      const value = certification(hash);
      mutate(value);
      writeFileSync(file, JSON.stringify({ version: 1, entries: { [hash]: value } }));
      expect(store.read(hash)).toBeNull();
    }
  });

  it("keeps at most 64 deterministic entries inside the file-size bound", () => {
    const first = tempStore();
    const second = tempStore();
    const values = Array.from({ length: 80 }, (_, index) => (
      index.toString(16).padStart(64, "0")
    ));
    for (const hash of values) first.store.write(certification(hash));
    for (const hash of values) second.store.write(certification(hash));
    const parsed = JSON.parse(readFileSync(first.file, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(parsed.entries)).toHaveLength(64);
    expect(statSync(first.file).size).toBeLessThanOrEqual(128 * 1024);
    expect(readFileSync(first.file, "utf8")).toBe(readFileSync(second.file, "utf8"));
  });

  it("recovers from corrupt and oversized stores on the next bounded write", () => {
    for (const contents of ["{broken", "x".repeat(128 * 1024 + 1)]) {
      const { file, store } = tempStore();
      writeFileSync(file, contents);
      const hash = "d".repeat(64);
      expect(store.read(hash)).toBeNull();
      store.write(certification(hash));
      expect(store.read(hash)?.fingerprint.hash).toBe(hash);
      expect(statSync(file).size).toBeLessThanOrEqual(128 * 1024);
    }
  });
});

