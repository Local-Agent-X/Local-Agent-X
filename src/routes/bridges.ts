// Barrel re-export — actual handlers live in ./bridges/{whatsapp,telegram,sync,protocols,cron,voice-clones,secrets,integrations,auth}.ts
// One module per bridge. Public API (handleBridgeRoutes) preserved.
export { handleBridgeRoutes } from "./bridges/index.js";
