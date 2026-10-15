// Public types for the language-intel subsystem — the single canonical owner
// of language intelligence (find-references, go-to-definition, file
// diagnostics). Callers depend on these shapes only, never on the TypeScript
// compiler API (or any future language backend) directly.

/** The ONE definition of the TS-family extensions language-intel handles —
 *  ts-provider's supports() and ts-project's hosted-file check both read this,
 *  so they can never drift apart. Includes .mjs/.cjs: the TS language service
 *  hosts them under allowJs (set in ts-project's DEFAULT_OPTIONS for the
 *  no-tsconfig path; tsconfig-owned projects rely on their own config).
 *  agent-guards/verify-gate.ts's deliberately-broader SOURCE_EXT_RE
 *  cross-references this constant but stays separate (it spans many
 *  languages). */
export const TS_FAMILY_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

/** A position in a source file. Line and column are 1-based. */
export interface SymbolLocation {
  file: string;
  line: number;
  column: number;
  /** Set by findSymbolPositions results: whether the identifier at this
   *  position is a declaration NAME or another occurrence. Optional — query
   *  inputs don't carry it. */
  kind?: "declaration" | "occurrence";
  /** Set on declaration results: true for a module-level declaration (a
   *  function, class, interface, type, enum or variable at the top of a file),
   *  false for a parameter, local or member of the same name. */
  topLevel?: boolean;
}

/** One exported module-level declaration. 1-based line. */
export interface ExportedDeclaration {
  name: string;
  /** function | class | interface | type | enum | variable */
  kind: string;
  file: string;
  line: number;
}

/** One reference (or definition) site for a symbol. 1-based line/column. */
export interface ReferenceHit {
  file: string;
  line: number;
  column: number;
  /** The full text of the line the hit sits on (no trailing newline). */
  lineText: string;
  /** True when this hit is the symbol's definition, not just a use. */
  isDefinition: boolean;
}

/** One compiler diagnostic for a file. 1-based line/column. */
export interface FileDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  code: string | number;
  severity: "error" | "warning";
}

/** A per-language backend. The facade in index.ts routes each query to the
 *  first provider whose supports() matches; unsupported languages get empty
 *  results, and callers implement their own fallbacks. */
export interface LanguageIntelProvider {
  supports(file: string): boolean;
  findReferences(loc: SymbolLocation): Promise<ReferenceHit[]>;
  findDefinition(loc: SymbolLocation): Promise<ReferenceHit[]>;
  getDiagnostics(files: string[]): Promise<FileDiagnostic[]>;
  /** Resolve a bare symbol name to AST-true positions under `root` —
   *  declaration sites first, then other identifier occurrences — without the
   *  comment/string false positives a regex scan would produce. */
  findSymbolPositions(
    root: string,
    symbolName: string,
    opts?: { limit?: number },
  ): Promise<SymbolLocation[]>;
  /** Every exported module-level declaration under `root`, from a pure parse
   *  (no type-check): what "does a function named X already exist" and a
   *  same-name-in-two-files check are answered from. */
  listExportedDeclarations(root: string): Promise<ExportedDeclaration[]>;
  dispose(): void;
}
