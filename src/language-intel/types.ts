// Public types for the language-intel subsystem — the single canonical owner
// of language intelligence (find-references, go-to-definition, file
// diagnostics). Callers depend on these shapes only, never on the TypeScript
// compiler API (or any future language backend) directly.

/** A position in a source file. Line and column are 1-based. */
export interface SymbolLocation {
  file: string;
  line: number;
  column: number;
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
  dispose(): void;
}
