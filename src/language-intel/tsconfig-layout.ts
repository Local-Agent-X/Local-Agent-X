// The one definition of a "solution" tsconfig, shared by everything that type-checks a
// project: the build-verify command (agent-guards/build-command.ts picks `tsc -b` for
// one) and the in-process language service (ts-project.ts follows its references to the
// project that owns a file). When the two disagreed, the language service checked a
// Vite app's .tsx files under the root tsconfig.json, which has no `jsx` setting, and
// reported errors (TS6142, TS17004) that `tsc -b` would never raise; the build worker
// was told to fix them (2026-10-14).
//
// Pure, no imports: readable from any layer.

/** A tsconfig that lists no files of its own and only references other projects: the
 *  standard Vite/CRA-TS root, `{ "files": [], "references": [tsconfig.app.json, …] }`.
 *  `tsc --noEmit` against it compiles nothing; `tsc -b` follows the references. */
export function isSolutionTsconfig(cfg: unknown): boolean {
  const c = cfg as { references?: unknown; files?: unknown; include?: unknown } | null;
  if (!c || !Array.isArray(c.references) || c.references.length === 0) return false;
  const noOwnFiles = !Array.isArray(c.files) || c.files.length === 0;
  const noInclude = !Array.isArray(c.include) || c.include.length === 0;
  return noOwnFiles && noInclude;
}

/** The `references[].path` entries of a tsconfig, as written (a file or a directory). */
export function referencePaths(cfg: unknown): string[] {
  const refs = (cfg as { references?: unknown } | null)?.references;
  if (!Array.isArray(refs)) return [];
  return refs
    .map((r) => (r as { path?: unknown } | null)?.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}
