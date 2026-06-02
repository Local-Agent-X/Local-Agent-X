/**
 * Post-write verification for tools that mutate disk. Call after
 * writeFile/writeFileSync to confirm the side-effect landed. Returns a
 * discriminated union — tools then propagate via err() from result-helpers.ts.
 *
 * Synchronous on purpose: tool result paths are already sync (ok()/err() are
 * sync builders) and a Promise would force every call site to await for no
 * real benefit over the underlying statSync.
 */
import { statSync, readFileSync } from "node:fs";

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyWriteLanded(
  filePath: string,
  opts?: { minBytes?: number; mustContain?: string },
): VerifyResult {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { ok: false, reason: `file not found at ${filePath}` };
  }

  if (opts?.minBytes !== undefined && size < opts.minBytes) {
    return { ok: false, reason: `file too small: ${size} bytes` };
  }

  if (opts?.mustContain !== undefined) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return { ok: false, reason: `file not found at ${filePath}` };
    }
    if (!content.includes(opts.mustContain)) {
      return { ok: false, reason: `file missing expected content: ${opts.mustContain}` };
    }
  }

  return { ok: true };
}
