import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

export function listProcessRelayOperationIds(): string[] {
  const operations = join(getLaxDir(), "operations");
  if (!existsSync(operations)) return [];
  return readdirSync(operations).filter(opId => {
    if (!/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/.test(opId)) return false;
    return existsSync(join(operations, opId, "process-relay"));
  });
}
