// One-time carry-over when the secrets file gains destination approvals
// (ADR 0005): a connector manifest written before the gate existed bound its
// secret to its upstream with the user's knowledge, so that pair is approved
// rather than left to 403 on the next request. Runs from bootstrap while the
// vault reports destinationSeedPending.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { connectorsDir, parseManifest, referencedSecrets } from "./connector-proxy.js";

export function seedConnectorDestinationApprovals(store: {
  approveDestination(name: string, destination: string): boolean;
}): number {
  let seeded = 0;
  let files: string[];
  try { files = readdirSync(connectorsDir()).filter((f) => f.endsWith(".json")); } catch { return 0; }
  for (const file of files) {
    let parsed: ReturnType<typeof parseManifest>;
    try { parsed = parseManifest(readFileSync(join(connectorsDir(), file), "utf-8")); } catch { continue; }
    if (!parsed.ok) continue;
    for (const name of referencedSecrets(parsed.manifest.auth)) {
      if (store.approveDestination(name, parsed.manifest.upstream)) seeded++;
    }
  }
  return seeded;
}
