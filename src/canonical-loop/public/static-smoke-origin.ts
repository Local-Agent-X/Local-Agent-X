/**
 * canonical-loop public sub-barrel: the loopback origin a static-build smoke
 * loads a finished build from, instead of `file://`.
 *
 * Its own barrel because build-adapters.ts drags the whole app-build
 * verification stack in, and the auto-build build gate needs only this server
 * (part of the sealed public interface, interface-seal.test.ts).
 */
export { startStaticSmokeOrigin, type SmokeOrigin, type SmokeMount } from "../adapters/app-build-smoke-origin.js";
