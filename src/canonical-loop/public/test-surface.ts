/**
 * canonical-loop public sub-barrel: TEST-ONLY reach-through.
 *
 * A test that lives outside canonical-loop but drives code the loop wraps
 * (server/background-jobs/self-edit-surgeon-runner.test.ts) needs the module's
 * per-test reset helpers and context factory. Those are deliberately off the
 * production surfaces — index.ts and the other public/* barrels — because no
 * shipping code should ever call them.
 *
 * Routing that need through ONE named door keeps the seal enforceable instead
 * of granting tests a blanket exemption from it: the seal has a companion
 * assertion that no NON-test file may import this barrel, so a production
 * caller reaching for a reset helper fails CI the same way a deep import does.
 */
export { _resetOpLedgers } from "../instruction-ledger/ledger.js";
export { _resetMiddlewareStates } from "../middlewares/state.js";
export { makeCanonicalLoopContext } from "../middlewares/ctx.test-helper.js";
