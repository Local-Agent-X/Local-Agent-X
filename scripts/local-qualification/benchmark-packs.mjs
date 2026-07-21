export const QUALIFICATION_BENCHMARK_CATALOG_SCHEMA = "lax.qualification-benchmark-catalog";
export const QUALIFICATION_BENCHMARK_CATALOG_VERSION = 1;
export const QUALIFICATION_BENCHMARK_PACK_SCHEMA = "lax.qualification-benchmark-pack";
export const QUALIFICATION_BENCHMARK_PACK_SCHEMA_VERSION = 1;

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SCRIPT = /^test:[a-z0-9][a-z0-9:-]{0,127}$/;
const NPM_SCRIPT = /^[a-z0-9][a-z0-9:-]{0,127}$/;
const TEST_PATH = /^(?:test|src)\/[a-z0-9][a-z0-9._/-]*\.test\.ts$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exact(value, keys, label) {
  const actual = Object.keys(value).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function text(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function version(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function testPath(value, label) {
  const path = text(value, label, TEST_PATH);
  if (path.includes("//") || path.split("/").includes("..")) throw new Error(`${label} is invalid`);
  return path;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function parseQualificationBenchmarkCatalog(value) {
  const catalog = record(value, "benchmark catalog");
  exact(catalog, ["schema", "version", "packs"], "benchmark catalog");
  if (catalog.schema !== QUALIFICATION_BENCHMARK_CATALOG_SCHEMA
    || catalog.version !== QUALIFICATION_BENCHMARK_CATALOG_VERSION) {
    throw new Error("unknown or stale benchmark catalog schema");
  }
  if (!Array.isArray(catalog.packs) || catalog.packs.length === 0) throw new Error("benchmark catalog packs must be non-empty");
  const paths = new Set();
  const packs = catalog.packs.map((item, packIndex) => {
    const pack = record(item, `packs[${packIndex}]`);
    exact(pack, ["schema", "schemaVersion", "id", "version", "gate", "scenarios"], `packs[${packIndex}]`);
    if (pack.schema !== QUALIFICATION_BENCHMARK_PACK_SCHEMA || pack.schemaVersion !== QUALIFICATION_BENCHMARK_PACK_SCHEMA_VERSION) {
      throw new Error(`packs[${packIndex}] has an unknown or stale schema`);
    }
    const id = text(pack.id, `packs[${packIndex}].id`, ID);
    const gate = record(pack.gate, `packs[${packIndex}].gate`);
    exact(gate, ["id", "script", "timeoutMs", "preflightScripts"], `packs[${packIndex}].gate`);
    const gateId = text(gate.id, `packs[${packIndex}].gate.id`, ID);
    if (gateId !== id) throw new Error(`packs[${packIndex}] gate id must match pack id`);
    const timeoutMs = version(gate.timeoutMs, `packs[${packIndex}].gate.timeoutMs`);
    if (!Array.isArray(gate.preflightScripts)) throw new Error(`packs[${packIndex}].gate.preflightScripts must be an array`);
    const preflightScripts = gate.preflightScripts.map((script, index) => text(script, `packs[${packIndex}].gate.preflightScripts[${index}]`, NPM_SCRIPT));
    if (new Set(preflightScripts).size !== preflightScripts.length) throw new Error(`packs[${packIndex}] has duplicate preflight scripts`);
    if (!Array.isArray(pack.scenarios) || pack.scenarios.length === 0) throw new Error(`packs[${packIndex}] scenarios must be non-empty`);
    const scenarios = pack.scenarios.map((entry, scenarioIndex) => {
      const scenario = record(entry, `packs[${packIndex}].scenarios[${scenarioIndex}]`);
      exact(scenario, ["id", "version", "testPath", "assertionCount", "assertionManifestSha256", "platformIndependent", "allowedSkips"], `packs[${packIndex}].scenarios[${scenarioIndex}]`);
      const path = testPath(scenario.testPath, `packs[${packIndex}].scenarios[${scenarioIndex}].testPath`);
      if (paths.has(path)) throw new Error(`benchmark test path is reused: ${path}`);
      paths.add(path);
      const scenarioId = text(scenario.id, `packs[${packIndex}].scenarios[${scenarioIndex}].id`, ID);
      if (typeof scenario.platformIndependent !== "boolean") throw new Error(`${scenarioId}.platformIndependent is invalid`);
      if (!Array.isArray(scenario.allowedSkips)) throw new Error(`packs[${packIndex}].scenarios[${scenarioIndex}].allowedSkips must be an array`);
      const allowedSkips = scenario.allowedSkips.map((entry, skipIndex) => {
        const skip = record(entry, `packs[${packIndex}].scenarios[${scenarioIndex}].allowedSkips[${skipIndex}]`);
        exact(skip, ["identitySha256", "compensationScenarioId"], `packs[${packIndex}].scenarios[${scenarioIndex}].allowedSkips[${skipIndex}]`);
        return {
          identitySha256: text(skip.identitySha256, "allowed skip identity", SHA256),
          compensationScenarioId: text(skip.compensationScenarioId, "allowed skip compensation", ID),
        };
      });
      if (new Set(allowedSkips.map((skip) => skip.identitySha256)).size !== allowedSkips.length) throw new Error(`${scenarioId} has duplicate allowed skip identities`);
      return {
        id: scenarioId,
        version: version(scenario.version, `packs[${packIndex}].scenarios[${scenarioIndex}].version`),
        testPath: path,
        assertionCount: version(scenario.assertionCount, `${scenarioId}.assertionCount`),
        assertionManifestSha256: text(scenario.assertionManifestSha256, `${scenarioId}.assertionManifestSha256`, SHA256),
        platformIndependent: scenario.platformIndependent,
        allowedSkips,
      };
    });
    if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) throw new Error(`packs[${packIndex}] has duplicate scenario ids`);
    const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
    for (const scenario of scenarios) {
      for (const skip of scenario.allowedSkips) {
        const compensation = scenarios.find((item) => item.id === skip.compensationScenarioId);
        if (!compensation || compensation.id === scenario.id || !compensation.platformIndependent) {
          throw new Error(`${scenario.id} has an invalid skip compensation`);
        }
      }
    }
    return {
      schema: QUALIFICATION_BENCHMARK_PACK_SCHEMA,
      schemaVersion: QUALIFICATION_BENCHMARK_PACK_SCHEMA_VERSION,
      id,
      version: version(pack.version, `packs[${packIndex}].version`),
      gate: { id: gateId, script: text(gate.script, `packs[${packIndex}].gate.script`, SCRIPT), timeoutMs, preflightScripts },
      scenarios,
    };
  });
  if (new Set(packs.map((pack) => pack.id)).size !== packs.length) throw new Error("benchmark catalog has duplicate pack ids");
  const scenarioIds = packs.flatMap((pack) => pack.scenarios.map((scenario) => scenario.id));
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error("benchmark catalog has duplicate scenario ids");
  return deepFreeze({
    schema: QUALIFICATION_BENCHMARK_CATALOG_SCHEMA,
    version: QUALIFICATION_BENCHMARK_CATALOG_VERSION,
    packs,
  });
}

const definition = {
  schema: QUALIFICATION_BENCHMARK_CATALOG_SCHEMA,
  version: QUALIFICATION_BENCHMARK_CATALOG_VERSION,
  packs: [
    {
      schema: QUALIFICATION_BENCHMARK_PACK_SCHEMA, schemaVersion: 1, id: "installer", version: 2,
      gate: { id: "installer", script: "test:installer-qualification", timeoutMs: 10 * 60_000, preflightScripts: [] },
      scenarios: [
        { id: "contract", version: 1, testPath: "test/installer-contract.test.ts", assertionCount: 23, assertionManifestSha256: "sha256:e3ab089e51e06f1b15df9b891a28e89a92ffab3456dcd18797a344e77ae0cf30", platformIndependent: false, allowedSkips: [] },
        { id: "resume", version: 1, testPath: "test/installer-resume.test.ts", assertionCount: 19, assertionManifestSha256: "sha256:c430e624a1adf05a7d5d087de4ff00cf9a2c76a8496f6fc2caae1716304df097", platformIndependent: false, allowedSkips: [] },
        { id: "rollback", version: 1, testPath: "test/installer-rollback.test.ts", assertionCount: 42, assertionManifestSha256: "sha256:a08288ddc1a87ac234e4f8a1f59d1ef14c92208c4236e494758ae86cc581a087", platformIndependent: false, allowedSkips: [] },
      ],
    },
    {
      schema: QUALIFICATION_BENCHMARK_PACK_SCHEMA, schemaVersion: 1, id: "local-model", version: 2,
      gate: { id: "local-model", script: "test:local-product-qualification", timeoutMs: 45 * 60_000, preflightScripts: ["check:release-environment", "test:prepare"] },
      scenarios: [
        { id: "product", version: 1, testPath: "test/local-model-qualification.test.ts", assertionCount: 27, assertionManifestSha256: "sha256:39dc76d61f4a6e2265c9f02cb946364d20d5e8f0010964e735eaff552ea614e6", platformIndependent: false, allowedSkips: [] },
        { id: "evidence", version: 1, testPath: "test/local-model-qualification-evidence.test.ts", assertionCount: 53, assertionManifestSha256: "sha256:9a4c46bdadf0489fc3dc843dc1e2c08380122f9644d51119a5cec7e6513a9568", platformIndependent: false, allowedSkips: [] },
        { id: "isolation", version: 1, testPath: "test/local-model-qualification-isolation.test.ts", assertionCount: 52, assertionManifestSha256: "sha256:3b7d18b1a83f5a5eb1810a9cf5b563e723637dcaa495c81378b579f8ac1244fd", platformIndependent: false, allowedSkips: [] },
        { id: "proxy", version: 1, testPath: "test/local-model-qualification-proxy.test.ts", assertionCount: 2, assertionManifestSha256: "sha256:65c91236b3c5495a9f278da063764fe17f05d508906249adaac67abcbee39bb7", platformIndependent: false, allowedSkips: [] },
      ],
    },
    {
      schema: QUALIFICATION_BENCHMARK_PACK_SCHEMA, schemaVersion: 1, id: "plugins", version: 2,
      gate: { id: "plugins", script: "test:plugin-qualification", timeoutMs: 10 * 60_000, preflightScripts: [] },
      scenarios: [
        { id: "lifecycle-transactions", version: 1, testPath: "test/plugin-lifecycle-transactions.test.ts", assertionCount: 12, assertionManifestSha256: "sha256:2d2dd6b01202409a37c97a1678d3e3ffbb04b83cf8cd91ed9e5771bea0e07f2f", platformIndependent: false, allowedSkips: [] },
        { id: "registry-runtime-failures", version: 1, testPath: "test/plugin-registry-runtime-failures.test.ts", assertionCount: 22, assertionManifestSha256: "sha256:271d6444f9f61a86869fe3e00680797475ebde469b99d567dcc630c648b5829e", platformIndependent: false, allowedSkips: [] },
        { id: "metadata-convergence", version: 1, testPath: "test/plugin-metadata-convergence.test.ts", assertionCount: 8, assertionManifestSha256: "sha256:fdfdcf8274a67a0a1b73c95af3f38dd3e1c33c1121986f2d650a3dbb7cbefa3a", platformIndependent: false, allowedSkips: [] },
        { id: "secret-prerequisites", version: 1, testPath: "test/plugin-secret-prerequisites.test.ts", assertionCount: 13, assertionManifestSha256: "sha256:6161136e672b19239b1a4e19448deb7359671245a9be9be2e31594072ee73c5c", platformIndependent: false, allowedSkips: [] },
      ],
    },
    {
      schema: QUALIFICATION_BENCHMARK_PACK_SCHEMA, schemaVersion: 1, id: "channels", version: 2,
      gate: { id: "channels", script: "test:channel-qualification", timeoutMs: 10 * 60_000, preflightScripts: [] },
      scenarios: [
        { id: "channel-registry", version: 1, testPath: "src/session/channel-registry.test.ts", assertionCount: 3, assertionManifestSha256: "sha256:7b1eea2f682059379f902e3fcdbb2a1afaa2c96b42b7161d7006104658df1ac8", platformIndependent: false, allowedSkips: [] },
        { id: "inbound-channel-runner", version: 1, testPath: "src/server/inbound-channel-runner.test.ts", assertionCount: 12, assertionManifestSha256: "sha256:e916acdbe3fce9db934bfee380ff4517a9f04eba3add63ed67427ff07a374a7f", platformIndependent: false, allowedSkips: [] },
        { id: "phone-projection", version: 1, testPath: "src/broker-transport/phone-projection.test.ts", assertionCount: 26, assertionManifestSha256: "sha256:e3bfb1843a1c85f09781be024eeebbc5870ddb7494ab96a15c9505fa28d05f25", platformIndependent: false, allowedSkips: [] },
        { id: "telegram-bridge", version: 1, testPath: "src/telegram-bridge/bridge.test.ts", assertionCount: 11, assertionManifestSha256: "sha256:35c9cf93c93bce806c12fa91f36a2b0bb3373a76645fea5f2e8fcd29266d7fc7", platformIndependent: false, allowedSkips: [] },
        { id: "whatsapp-message-handler", version: 1, testPath: "src/whatsapp-bridge/message-handler.test.ts", assertionCount: 10, assertionManifestSha256: "sha256:a0bae2a84b9160bfe02f79d286e1edd97f22bf4bb908a0db78171e0460944531", platformIndependent: false, allowedSkips: [] },
      ],
    },
  ],
};

export const qualificationBenchmarkCatalog = parseQualificationBenchmarkCatalog(definition);
export function qualificationSourceCommand(pack) {
  const preflight = pack.gate.preflightScripts.map((script) => `npm run ${script}`);
  return [...preflight, `vitest run ${pack.scenarios.map((scenario) => scenario.testPath).join(" ")}`].join(" && ");
}

export const qualificationBenchmarkGates = deepFreeze(qualificationBenchmarkCatalog.packs.map((pack) => ({
  id: pack.gate.id,
  script: pack.gate.script,
  timeoutMs: pack.gate.timeoutMs,
  benchmarkPackId: pack.id,
})));

export function projectQualificationPackContract(pack) {
  const catalog = parseQualificationBenchmarkCatalog({
    schema: QUALIFICATION_BENCHMARK_CATALOG_SCHEMA,
    version: QUALIFICATION_BENCHMARK_CATALOG_VERSION,
    packs: [pack],
  });
  const normalized = catalog.packs[0];
  return deepFreeze({
    id: normalized.id,
    version: normalized.version,
    scenarios: normalized.scenarios.map(({ id, version: scenarioVersion }) => ({ id, version: scenarioVersion })),
  });
}

export const qualificationPackContracts = deepFreeze(qualificationBenchmarkCatalog.packs.map(projectQualificationPackContract));
