/**
 * Provider adapter registry — maps a provider identifier to its adapter
 * instance. The dispatcher resolves an adapter by name; adding a new
 * provider = one register() call at boot.
 *
 * Identifiers are dash-cased and reflect both the provider AND the
 * transport: "anthropic-http" vs "anthropic-cli" are two distinct
 * adapters because their failure modes and auth paths differ.
 *
 * Pattern from /tmp/compare/upstream-agent-main/agent/__init__.py — flat
 * map, no inheritance tricks, easy to grep.
 */

import type { BaseAdapter } from "./base-adapter.js";

const _adapters = new Map<string, BaseAdapter>();

export function registerAdapter(adapter: BaseAdapter): void {
  if (_adapters.has(adapter.name)) {
    throw new Error(`Adapter already registered: ${adapter.name}`);
  }
  _adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): BaseAdapter | undefined {
  return _adapters.get(name);
}

export function requireAdapter(name: string): BaseAdapter {
  const a = _adapters.get(name);
  if (!a) {
    const known = [..._adapters.keys()].join(", ") || "(none)";
    throw new Error(`Unknown provider adapter: ${name}. Registered: ${known}`);
  }
  return a;
}

export function listAdapters(): string[] {
  return [..._adapters.keys()];
}

/** Test-only: clear the registry. Production code never calls this. */
export function _resetRegistryForTests(): void {
  _adapters.clear();
}
