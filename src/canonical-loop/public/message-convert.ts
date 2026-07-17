/**
 * canonical-loop public sub-barrel: op-message → chat-param conversion.
 *
 * opMessageRowToChatParam turns a committed op-message row into the
 * ChatCompletionMessageParam shape the session store and persistence use. It
 * is on the front-door index too, but tests that MOCK canonical-loop/index.js
 * need the real function via a path the mock doesn't intercept — and the
 * source module is a pure leaf (type-only imports), so this barrel adds no
 * reachability beyond the old deep import.
 */
export { opMessageRowToChatParam } from "../chat-runner/message-convert.js";
