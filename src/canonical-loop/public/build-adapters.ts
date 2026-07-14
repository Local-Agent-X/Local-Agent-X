/**
 * canonical-loop public sub-barrel: app-build adapter surface + adapter
 * transport infrastructure.
 *
 * NOT re-exported from index.ts, deliberately: app-build-adapter drags the
 * whole app-build verification stack (tools/verify, framework-detect,
 * dev-server, the Anthropic adapter) into whoever loads it. Folding that
 * into the index barrel would grow the graph of every index consumer and
 * mint new cycles through tools/ and routes/. Callers that need this
 * surface (tools/build-app, tools/build-session-context, codex-client
 * tests) import this barrel directly — it is part of the sealed public
 * interface (see interface-seal.test.ts, which allows canonical-loop/public/*).
 */
export {
	createAppBuildAdapter,
	type AppBuildAdapterOptions,
} from "../adapters/app-build-adapter.js";

export { VERIFY_EVIDENCE_MARKER } from "../adapters/app-build-verify-adapter.js";

export { withTransportRetry } from "../adapters/transport-retry.js";

export { registerFrameworkDevServerFromDisk } from "../adapters/app-build-finalize.js";
