// Barrel for the secret-detection cluster (scanning, known-secret registry,
// credential patterns, outbound-payload decomposition). Exports only what
// external callers actually import — surveyed 2026-07-11. Must not import
// from ../layer (dep direction is layer -> secrets, one-way).
export { scanForSecrets, redactSecrets, decodedPayloadViews } from "./secret-scanner.js";
export {
	isSecretShaped,
	knownSecretValues,
	registerRedactedSecretValue,
	unregisterRedactedSecretValue,
	isAppAtRestSecretBasename,
	APP_AT_REST_SECRET_BASENAMES,
} from "./known-secrets.js";
export { CREDENTIAL_ENV_PREFIXES, CREDENTIAL_KEY_PATTERNS, redact } from "./credential-patterns.js";
export { redactCredentials } from "./credentials.js";
export { outboundPayloadParts } from "./outbound-payload.js";
