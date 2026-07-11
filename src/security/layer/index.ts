// Barrel for the SecurityLayer decision core (policy evaluation: file access,
// shell, network, config, audit). Exports only what external callers actually
// import — surveyed 2026-07-11. Files inside src/security/ may deep-import.
export type { CallContext, FileAccessMode } from "./types.js";
export { CONTEXT_RESTRICTED_TOOLS, WORKTREE_REQUIRED_TOOLS } from "./types.js";
export { SecurityLayer } from "./layer-core.js";
export {
	evaluateFileAccess,
	confineToDir,
	matchesSensitivePath,
	realpathDeep,
	isSanctionedWorkRootEnvFile,
} from "./file-access.js";
export { readValidatedFile, writeValidatedFile, openValidatedRead } from "./validated-io.js";
export {
	evaluateEgressForUrl,
	resolveAndPinHost,
	matchEgressList,
	evaluateWebFetch,
} from "./network-policy.js";
export {
	loadDataEgressGuard,
	loadFileAccessMode,
	loadFileAccessModeAtLeast,
	ollamaPortFromUrl,
} from "./security-config.js";
export { evaluateShellCommand, detectObfuscation } from "./shell-policy.js";
export { evaluateShellCommandAndPaths } from "./shell-path-guard.js";
export { shellCommandWritesFiles } from "./shell-write-detector.js";
export { classifySensitivePath } from "./sensitive-paths.js";
export { runSecurityAudit, printAuditReport } from "./security-audit.js";
