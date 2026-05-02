/**
 * Context references — file/url reference handling for context injection.
 *
 * upstream pattern: dedicated module for "user mentioned a file or URL,
 * fetch it and inject as context." Today SAX handles file refs through
 * the read tool (lazy, agent-driven) which is fine — this file is a
 * placeholder for when we want eager reference resolution at turn start.
 *
 * Empty for now. The named module establishes the boundary so future
 * eager-fetch logic has a home.
 */

export {};
