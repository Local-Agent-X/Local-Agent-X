/**
 * canonical-loop public sub-barrel: render/design verification bridge.
 *
 * The hooks the host process (server bootstrap, IDE websocket) uses to feed
 * preview runtime errors and design specs/verdicts into the turn loop's
 * verify middlewares, and to read them back. Both source modules are leaves
 * (type-only imports), so this barrel is cycle-safe for consumers inside
 * canonical-loop's runtime orbit (e.g. chat-ws/ide-runtime-error, which the
 * heavy index barrel transitively reaches).
 *
 * index.ts re-exports this barrel, so the symbols are also part of the
 * front-door API for out-of-orbit callers.
 */
export {
	setRenderProbe,
	pushPreviewRuntimeError,
	listOpsForApp,
	type PreviewRuntimeError,
} from "../turn-loop/render-verify.js";

export {
	recordDesignSpec,
	getDesignSpec,
	recordDesignVerdict,
} from "../turn-loop/design-verify.js";
