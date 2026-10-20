// Barrel re-export — actual handlers live in ./settings/{system,diagnostics,plugins,preferences,providers,security,mood}.ts
// One module per settings area. Public API (handleSettingsRoutes) preserved.
export { handleSettingsRoutes } from "./settings/index.js";
