// Barrel re-export — actual handlers live in ./bridges/{whatsapp,telegram,sync,protocols,cron,voice-clones,secrets,integrations,auth}.ts
// Split for the 400-LOC-per-file rule. Public API (handleBridgeRoutes) preserved.
export { handleBridgeRoutes } from "./bridges/index.js";
