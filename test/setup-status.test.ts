import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDegradedList, readInstallReport, isFullySetUp } from "../src/server/setup-status.js";

// The in-app repair surface reads from two sources that disagree by design:
// the installer's record of what degraded at install time, and a live probe of
// the running embedding provider. These tests pin which one wins, because
// getting it backwards reproduces two bugs this codebase has already paid for:
//   • a stale flag outliving the condition it described (the pre-checked
//     "Connect an AI provider" that got the Getting Started checklist deleted)
//   • a failed probe read as a fault, turning a network blip into a permanent
//     "something's broken" banner
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-setup-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const writeReport = (degraded: unknown) =>
  writeFileSync(join(dir, "install-report.json"), JSON.stringify({ installedAt: "2026-07-14T00:00:00Z", degraded }));

const hardwareProfile = () => ({
  version: 1, platform: "linux", arch: "arm64",
  cpu: { model: null, logicalCores: null }, memory: { totalBytes: null },
  gpu: { status: "unknown", devices: [], multiGpu: false, sharedMemory: false },
  ollama: { status: "not-installed", version: null, modelsStatus: "unknown", models: [] }, modelAdvisories: [],
});

describe("readInstallReport", () => {
  it("returns null when absent — an old install is not a clean install", () => {
    expect(readInstallReport(dir)).toBeNull();
  });

  it("returns null on corrupt JSON rather than throwing into the route", () => {
    writeFileSync(join(dir, "install-report.json"), "{not json");
    expect(readInstallReport(dir)).toBeNull();
  });

  it("reads the installer's degraded list", () => {
    writeReport([{ step: "ollama", message: "winget couldn't install Ollama (exit 2316632158)" }]);
    expect(readInstallReport(dir)?.degraded).toHaveLength(1);
  });

  it("roundtrips advisory hardware evidence without treating unknown hardware as degraded", () => {
    const profile = hardwareProfile();
    writeFileSync(join(dir, "install-report.json"), JSON.stringify({ degraded: [], hardwareProfile: profile }));
    expect(readInstallReport(dir)?.hardwareProfile).toEqual(profile);
    expect(buildDegradedList(null, readInstallReport(dir))).toEqual([]);
    expect(isFullySetUp(buildDegradedList(null, readInstallReport(dir)))).toBe(true);
  });

  it.each([
    ["null GPU entry", (profile: ReturnType<typeof hardwareProfile>) => ({ ...profile, gpu: { ...profile.gpu, devices: [null] } })],
    ["null advisory", (profile: ReturnType<typeof hardwareProfile>) => ({ ...profile, modelAdvisories: [null] })],
    ["oversized architecture", (profile: ReturnType<typeof hardwareProfile>) => ({ ...profile, arch: "x".repeat(33) })],
    ["oversized model inventory", (profile: ReturnType<typeof hardwareProfile>) => ({
      ...profile, ollama: { ...profile.ollama, models: Array.from({ length: 129 }, (_, index) => ({ name: `m${index}`, sizeBytes: null })) },
    })],
  ])("drops malformed advisory evidence (%s) without changing setup readiness", (_label, mutate) => {
    writeFileSync(join(dir, "install-report.json"), JSON.stringify({ degraded: [], hardwareProfile: mutate(hardwareProfile()) }));
    const report = readInstallReport(dir);
    expect(report).not.toBeNull();
    expect(report?.hardwareProfile).toBeNull();
    const components = buildDegradedList(null, report);
    expect(components).toEqual([]);
    expect(isFullySetUp(components)).toBe(true);
  });
});

describe("buildDegradedList — the live probe is authoritative", () => {
  it("reports NOTHING degraded when the probe says healthy, even if the installer failed", () => {
    // The 2026-07-14 machine: Ollama degraded during install, user installed it
    // by hand afterwards. The report says "ollama" forever — it must not
    // outlive the condition and nag a user whose setup now works.
    writeReport([{ step: "ollama", message: "winget couldn't install Ollama (exit 2316632158)" }]);
    const components = buildDegradedList(false, readInstallReport(dir));
    expect(components).toEqual([]);
    expect(isFullySetUp(components)).toBe(true);
  });

  it("reports degraded on a live fault even when NO install report exists", () => {
    // Dev clone / pre-fix install: no report on disk, but Ollama is genuinely
    // down right now. Live truth stands on its own.
    const components = buildDegradedList(true, null);
    expect(components).toHaveLength(1);
    expect(components[0].id).toBe("ollama");
    expect(components[0].action).toBe("reinit-embeddings");
  });

  it("stays SILENT when the probe is unknown — a blip is not a fault", () => {
    writeReport([{ step: "ollama", message: "winget couldn't install Ollama" }]);
    // null = probe failed or hasn't run. Even with a damning install report,
    // unknown must not render a banner.
    expect(buildDegradedList(null, readInstallReport(dir))).toEqual([]);
  });
});

describe("probeEmbeddingsDegraded — must not infer from the singleton", () => {
  // Regression: the first cut read the embedding singleton and treated an
  // absent one as "unknown". But bootstrap-services returns EARLY without
  // setting the singleton precisely when Ollama is unreachable — so the worst
  // case (no Ollama at all) was indistinguishable from "user chose none", and
  // the route reported ready:true on a machine with no Ollama. Caught by
  // driving the live route; unit tests had mocked the seam away.
  //
  // The invariant: the probe asks the configured provider's real reachability,
  // never the singleton. Pinned structurally — a live network probe here would
  // be a flaky test that depends on whether Ollama happens to be running.
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/server/setup-status.ts", import.meta.url)),
    "utf-8",
  );
  const fn = SRC.slice(SRC.indexOf("export async function probeEmbeddingsDegraded"));

  it("does not read the embedding singleton", () => {
    expect(fn).not.toMatch(/getEmbeddingProviderSingleton|embedding-singleton/);
  });

  it("probes Ollama's real reachability, like bootstrap does", () => {
    expect(fn).toMatch(/fetchLocalOllamaTags/);
    expect(fn).toMatch(/reachable/);
  });

  it("treats a reachable Ollama with the model missing as degraded", () => {
    // Empty vectors + silent keyword fallback is just as degraded as no daemon.
    expect(fn).toMatch(/embeddingModelInstalled/);
  });

  it("returns null rather than throwing out of the route", () => {
    expect(fn).toMatch(/catch\s*\{[\s\S]*?return null/);
  });
});

describe("buildDegradedList — the report supplies the REASON", () => {
  it("uses the installer's message when it recorded one", () => {
    writeReport([{ step: "ollama", message: "winget couldn't install Ollama (exit 2316632158)" }]);
    const [c] = buildDegradedList(true, readInstallReport(dir));
    expect(c.reason).toContain("2316632158");
  });

  it("falls back to the live symptom when the install predates the report", () => {
    const [c] = buildDegradedList(true, null);
    expect(c.reason).toContain("isn't reachable");
    // Always give the user the manual escape hatch — repair can fail.
    expect(c.manual).toContain("ollama.com");
  });

  it("ignores a report entry for a DIFFERENT step", () => {
    writeReport([{ step: "python", message: "Python install failed" }]);
    const [c] = buildDegradedList(true, readInstallReport(dir));
    expect(c.reason).not.toContain("Python");
    expect(c.reason).toContain("isn't reachable");
  });
});
