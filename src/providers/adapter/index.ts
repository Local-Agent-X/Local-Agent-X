/**
 * Adapter contract — public surface of src/providers/adapter/.
 *
 * Importers depend on this index, never reach into individual files.
 * That way base-adapter / registry internals can be reorganized without
 * breaking call sites.
 */

export type {
  ProviderRequest,
  ProviderResponse,
  StreamChunk,
  ToolCall,
} from "./types.js";

export { BaseAdapter } from "./base-adapter.js";
export {
  registerAdapter,
  getAdapter,
  requireAdapter,
  listAdapters,
  setRegistryOverride,
} from "./registry.js";
