export const RELEASE_GATE_SCHEMA = 1;

export const releaseGates = [
  { id: "environment", script: "check:release-environment", timeoutMs: 60_000 },
  { id: "dependency-audit", args: ["audit", "--production", "--audit-level=high"], timeoutMs: 5 * 60_000 },
  { id: "build", script: "build", timeoutMs: 15 * 60_000 },
  { id: "full-tests", script: "test:release-full", timeoutMs: 45 * 60_000 },
  { id: "installer", script: "test:installer-qualification", timeoutMs: 10 * 60_000 },
  { id: "local-model", script: "test:local-product-qualification", timeoutMs: 45 * 60_000 },
  { id: "plugins", script: "test:plugin-qualification", timeoutMs: 10 * 60_000 },
  { id: "channels", script: "test:channel-qualification", timeoutMs: 10 * 60_000 },
  { id: "attribution", script: "check:release-attribution", timeoutMs: 60_000 },
];
