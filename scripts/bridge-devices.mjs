#!/usr/bin/env node
// Bridge device CLI — list or revoke paired mobile devices directly against the
// on-disk registry (~/.lax/devices.json). Works whether or not the server is
// running; revoking here flips the persisted status, and the running server's
// next auth check (or the operator revoke route, which also closes live
// sockets) honors it.
//
// Usage:
//   node scripts/bridge-devices.mjs list
//   node scripts/bridge-devices.mjs revoke <deviceId>
//
// For instant live-socket teardown of a connected device, prefer the operator
// route POST /api/bridge/devices/:id/revoke (it also closes open WebSockets).

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function laxDir() {
  return process.env.LAX_DATA_DIR || join(homedir(), ".lax");
}
function devicesPath() {
  return join(laxDir(), "devices.json");
}

function load() {
  const p = devicesPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return []; }
}

function save(devices) {
  const p = devicesPath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(devices, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, p);
}

const [, , cmd, arg] = process.argv;

if (cmd === "list") {
  const devices = load();
  if (devices.length === 0) { console.log("No paired devices."); process.exit(0); }
  for (const d of devices) {
    console.log(`${d.id}  ${d.status.padEnd(8)}  ${d.label}  (paired ${new Date(d.pairedAt).toISOString()}, last seen ${new Date(d.lastSeen).toISOString()})`);
  }
  process.exit(0);
}

if (cmd === "revoke") {
  if (!arg) { console.error("Usage: node scripts/bridge-devices.mjs revoke <deviceId>"); process.exit(2); }
  const devices = load();
  const d = devices.find((x) => x.id === arg);
  if (!d) { console.error(`Device not found: ${arg}`); process.exit(1); }
  if (d.status === "revoked") { console.log(`Already revoked: ${arg}`); process.exit(0); }
  d.status = "revoked";
  save(devices);
  console.log(`Revoked ${arg} (${d.label}). Restart the server or use the operator revoke route to drop any live socket.`);
  process.exit(0);
}

console.error("Usage:\n  node scripts/bridge-devices.mjs list\n  node scripts/bridge-devices.mjs revoke <deviceId>");
process.exit(2);
