/**
 * Adapter bootstrap — instantiate every concrete adapter and register
 * it with the registry. Importing this module once at boot is what makes
 * `requireAdapter("anthropic-cli")` etc. resolve.
 *
 * Idempotent: repeated imports are no-ops because registerAdapter throws
 * on duplicate names and we swallow the throw.
 */

import { registerAdapter } from "../adapter/registry.js";
import { anthropicHttpAdapter } from "./anthropic-http.js";
import { anthropicCliAdapter } from "./anthropic-cli.js";
import { openaiHttpAdapter } from "./openai-http.js";
import { codexCliAdapter } from "./codex-cli.js";
import { ollamaHttpAdapter } from "./ollama-http.js";

let _registered = false;
export function registerBuiltinAdapters(): void {
  if (_registered) return;
  _registered = true;
  registerAdapter(anthropicHttpAdapter);
  registerAdapter(anthropicCliAdapter);
  registerAdapter(openaiHttpAdapter);
  registerAdapter(codexCliAdapter);
  registerAdapter(ollamaHttpAdapter);
}

// Auto-register on import — simplest wiring; callers can still call the
// function explicitly if they want deterministic init order.
registerBuiltinAdapters();

export {
  anthropicHttpAdapter,
  anthropicCliAdapter,
  openaiHttpAdapter,
  codexCliAdapter,
  ollamaHttpAdapter,
};
