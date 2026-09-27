#!/usr/bin/env node
// Move agent-authored protocols out of workspace/protocols/custom.json into
// learned drafts (src/protocols/migrate-agent-protocols.ts).
//
//   node --import=tsx scripts/migrate-agent-protocols.ts           # dry run: print the plan
//   node --import=tsx scripts/migrate-agent-protocols.ts --apply   # migrate (writes a backup first)
//
// Quit the app first: the running server writes the same stores.
import { loadConfig, setRuntimeConfig } from "../src/config.js";

setRuntimeConfig(loadConfig());
const { migrateAgentAuthoredProtocols, planAgentProtocolMigration } =
  await import("../src/protocols/migrate-agent-protocols.js");

if (!process.argv.includes("--apply")) {
  console.log(JSON.stringify(planAgentProtocolMigration(), null, 2));
  console.log("Dry run. Re-run with --apply to migrate.");
} else {
  console.log(JSON.stringify(await migrateAgentAuthoredProtocols(), null, 2));
}
