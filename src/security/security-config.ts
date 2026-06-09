import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getLaxDir } from "../lax-data-dir.js";
import type { FileAccessMode } from "./types.js";
import type { EgressMode } from "./network-policy.js";

import { createLogger } from "../logger.js";
const logger = createLogger("security.layer-core");

export function loadEgressMode(): EgressMode {
  try {
    const cfgPath = join(getLaxDir(), "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.egressMode === "strict" || cfg.egressMode === "permissive") {
        return cfg.egressMode;
      }
    }
  } catch {}
  return "permissive";
}

export function loadLocalServicePorts(): Set<string> {
  const ports = new Set<string>();
  try {
    const cfgPath = join(getLaxDir(), "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (Array.isArray(cfg.localServicePorts)) {
        for (const p of cfg.localServicePorts) {
          const n = Number(p);
          if (Number.isInteger(n) && n > 0 && n <= 65535) ports.add(String(n));
        }
      }
    }
  } catch {}
  if (ports.size > 0) {
    logger.info(`[security] Local service ports loaded: ${ports.size} ports`);
  }
  return ports;
}

export function loadFileAccessMode(): FileAccessMode {
  try {
    const cfgPath = join(getLaxDir(), "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (["workspace", "common", "unrestricted"].includes(cfg.fileAccessMode)) {
        return cfg.fileAccessMode;
      }
    }
  } catch {}
  return "common"; // Default
}
