// canonical-loop public sub-barrel: what kind of failure a runtime error is
// (billing, auth, rate limit, ...). auto-build reads it to stop a build whose
// model account cannot run a worker; it must not reach into the loop for it.
export { normalizeRuntimeFailure } from "../runtime-failure-category.js";
