// language-intel — the canonical facade for language intelligence
// (find-references, go-to-definition, file diagnostics, symbol lookup).
// Every caller in the repo goes through getLanguageIntel(); providers and
// their LanguageService plumbing are implementation detail behind it.
//
// Routing: each query goes to the first provider whose supports() matches
// the file. Unsupported languages answer empty ([] everywhere) — callers own
// their fallbacks (grep, etc.); this subsystem never guesses.

import type { ExportedDeclaration, FileDiagnostic, LanguageIntelProvider, ReferenceHit, SymbolLocation } from "./types.js";
import { TsLanguageIntelProvider } from "./ts-provider.js";
import { clearReachSources, symbolReach, type Reach, type ReachLimits } from "./reach.js";
import { symbolTargets, type SymbolQueryOptions } from "./symbol-query.js";

export type { ExportedDeclaration, FileDiagnostic, LanguageIntelProvider, ReferenceHit, SymbolLocation } from "./types.js";
export { IMPORT_LINE, enclosingDeclaration, type Reach, type ReachedDeclaration, type ReachLimits } from "./reach.js";
export { symbolQueryFile, type SymbolQueryOptions } from "./symbol-query.js";

export interface LanguageIntel {
  supports(file: string): boolean;
  findReferences(loc: SymbolLocation): Promise<ReferenceHit[]>;
  findDefinition(loc: SymbolLocation): Promise<ReferenceHit[]>;
  getDiagnostics(files: string[]): Promise<FileDiagnostic[]>;
  findSymbolPositions(root: string, symbolName: string, opts?: { limit?: number }): Promise<SymbolLocation[]>;
  listExportedDeclarations(root: string): Promise<ExportedDeclaration[]>;
  /** The declarations (or the position) a query names: `<Name>`,
   *  `<file>#<Name>` or `<file>:<line>[:col]` (symbol-query.ts). */
  symbolTargets(root: string, query: string, opts?: SymbolQueryOptions): Promise<SymbolLocation[]>;
  /** How far a change to `start` reaches, hop by hop, and the test files that
   *  use what it reaches (reach.ts). `isTest` says where the walk ends. */
  reach(start: SymbolLocation, depth: number, isTest: (file: string) => boolean, limits?: ReachLimits): Promise<Reach>;
  dispose(): void;
}

/** Lazily-created provider registry. Just the TS provider today; a new
 *  language means a new provider here, not a new subsystem. */
let providers: LanguageIntelProvider[] | null = null;

function ensureProviders(): LanguageIntelProvider[] {
  if (providers === null) providers = [new TsLanguageIntelProvider()];
  return providers;
}

function providerFor(file: string): LanguageIntelProvider | null {
  return ensureProviders().find((p) => p.supports(file)) ?? null;
}

export function getLanguageIntel(): LanguageIntel {
  const intel: LanguageIntel = {
    supports: (file) => providerFor(file) !== null,

    findReferences: async (loc) =>
      (await providerFor(loc.file)?.findReferences(loc)) ?? [],

    findDefinition: async (loc) =>
      (await providerFor(loc.file)?.findDefinition(loc)) ?? [],

    getDiagnostics: async (files) => {
      const out: FileDiagnostic[] = [];
      for (const provider of ensureProviders()) {
        const mine = files.filter((f) => provider.supports(f));
        if (mine.length > 0) out.push(...(await provider.getDiagnostics(mine)));
      }
      return out;
    },

    // Symbol lookup has no file to route on; aggregate across providers,
    // honoring the combined limit.
    findSymbolPositions: async (root, symbolName, opts) => {
      const limit = Math.max(1, opts?.limit ?? 20);
      const out: SymbolLocation[] = [];
      for (const provider of ensureProviders()) {
        if (out.length >= limit) break;
        out.push(...(await provider.findSymbolPositions(root, symbolName, { limit: limit - out.length })));
      }
      return out;
    },

    listExportedDeclarations: async (root) => {
      const out: ExportedDeclaration[] = [];
      for (const provider of ensureProviders()) out.push(...(await provider.listExportedDeclarations(root)));
      return out;
    },

    symbolTargets: (root, query, opts) => symbolTargets(intel.findSymbolPositions, root, query, opts),

    reach: (start, depth, isTest, limits) => symbolReach(intel.findReferences, start, depth, isTest, limits),

    dispose: disposeLanguageIntel,
  };
  return intel;
}

/** Dispose every provider (and their cached LanguageServices). For tests
 *  and process shutdown. */
export function disposeLanguageIntel(): void {
  clearReachSources();
  if (providers === null) return;
  for (const provider of providers) provider.dispose();
  providers = null;
}
