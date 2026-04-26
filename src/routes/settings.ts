// Barrel re-export — actual handlers live in ./settings/{system,diagnostics,plugins,preferences,providers,security,mood}.ts
// Split for the 400-LOC-per-file rule. Public API (handleSettingsRoutes) preserved.
export { handleSettingsRoutes } from "./settings/index.js";
