// Compat façade over the two real modules: layer/ (SecurityLayer policy core)
// and secrets/ (secret detection). Re-exports both sub-barrels' public names
// so existing `from "../security/index.js"` importers keep working unchanged.
export * from "./layer/index.js";
export * from "./secrets/index.js";
