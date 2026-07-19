import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import {
  CERTIFICATION_SCENARIOS,
  type CertificationFailure,
  type CertificationScenarioId,
  type CertificationScenarioResult,
  type LocalModelCertification,
} from "./certification-types.js";

interface StoreShape {
  version: 1;
  entries: Record<string, LocalModelCertification>;
}

const FAILURES = new Set<CertificationFailure>([
  "aborted",
  "auth_rejected",
  "bad_response",
  "context_rejected",
  "invalid_json",
  "missing_marker",
  "missing_tool_call",
  "runtime_unavailable",
  "server_error",
  "timeout",
  "transport_error",
]);
const MAX_ENTRIES = 64;
const MAX_STORE_BYTES = 128 * 1024;
const TRANSIENT_FAILURES = new Set<CertificationFailure>([
  "aborted",
  "auth_rejected",
  "runtime_unavailable",
  "server_error",
  "timeout",
  "transport_error",
]);

function nonNegativeInt(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function parseScenario(value: unknown): CertificationScenarioResult | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const calls = nonNegativeInt(row.calls);
  const latencyMs = nonNegativeInt(row.latencyMs);
  const failure = row.failure === null || FAILURES.has(row.failure as CertificationFailure)
    ? row.failure as CertificationFailure | null
    : undefined;
  if (typeof row.passed !== "boolean" || calls === null || latencyMs === null || failure === undefined) {
    return null;
  }
  if (calls > 1 || row.passed !== (failure === null) || (row.passed && calls !== 1)) return null;
  return { passed: row.passed, calls, latencyMs, failure };
}

function parseCertification(value: unknown): LocalModelCertification | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const fp = row.fingerprint as Record<string, unknown> | null;
  if (row.version !== 1 || !fp || typeof fp.hash !== "string" || !/^[a-f0-9]{64}$/.test(fp.hash)) return null;
  if (typeof fp.reusable !== "boolean" || !row.scenarios || typeof row.scenarios !== "object") return null;
  const scenarios = {} as Record<CertificationScenarioId, CertificationScenarioResult>;
  for (const id of CERTIFICATION_SCENARIOS) {
    const parsed = parseScenario((row.scenarios as Record<string, unknown>)[id]);
    if (!parsed) return null;
    scenarios[id] = parsed;
  }
  const passedCount = nonNegativeInt(row.passedCount);
  const callCount = nonNegativeInt(row.callCount);
  const totalLatencyMs = nonNegativeInt(row.totalLatencyMs);
  if (passedCount === null || callCount === null || totalLatencyMs === null) return null;
  const values = Object.values(scenarios);
  if (values.some((entry) => entry.calls !== 1)) return null;
  if (values.some((entry) => entry.failure && TRANSIENT_FAILURES.has(entry.failure))) return null;
  if (passedCount !== values.filter((entry) => entry.passed).length) return null;
  if (callCount !== values.reduce((sum, entry) => sum + entry.calls, 0)) return null;
  if (totalLatencyMs !== values.reduce((sum, entry) => sum + entry.latencyMs, 0)) return null;
  return {
    version: 1,
    fingerprint: { hash: fp.hash, reusable: fp.reusable },
    scenarios,
    passedCount,
    callCount,
    totalLatencyMs,
  };
}

export class LocalCertificationStore {
  constructor(private readonly file = join(getLaxDir(), "local-model-certifications.json")) {}

  read(fingerprintHash: string): LocalModelCertification | null {
    const result = this.readAll()[fingerprintHash];
    if (!result || result.fingerprint.hash !== fingerprintHash) return null;
    return result.fingerprint.reusable ? result : null;
  }

  write(certification: LocalModelCertification): void {
    const clean = parseCertification(certification);
    if (!clean) return;
    const existing = this.readAll();
    const keep = Object.keys(existing)
      .filter((key) => key !== clean.fingerprint.hash)
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
      .slice(0, MAX_ENTRIES - 1);
    const entries: Record<string, LocalModelCertification> = Object.fromEntries([
      ...keep.map((key) => [key, existing[key]] as const),
      [clean.fingerprint.hash, clean] as const,
    ].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    let shape: StoreShape = { version: 1, entries };
    let contents = JSON.stringify(shape, null, 2);
    while (Buffer.byteLength(contents, "utf8") > MAX_STORE_BYTES) {
      const removable = Object.keys(shape.entries).find((key) => key !== clean.fingerprint.hash);
      if (!removable) return;
      delete shape.entries[removable];
      shape = { version: 1, entries: shape.entries };
      contents = JSON.stringify(shape, null, 2);
    }
    const dir = dirname(this.file);
    const tmp = `${this.file}.tmp.${randomBytes(4).toString("hex")}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  private readAll(): Record<string, LocalModelCertification> {
    if (!existsSync(this.file)) return {};
    try {
      if (statSync(this.file).size > MAX_STORE_BYTES) return {};
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; entries?: unknown };
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return {};
      const entries: Record<string, LocalModelCertification> = {};
      for (const [key, value] of Object.entries(parsed.entries)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .slice(0, MAX_ENTRIES)) {
        const certification = parseCertification(value);
        if (certification && certification.fingerprint.hash === key) entries[key] = certification;
      }
      return entries;
    } catch {
      return {};
    }
  }
}
