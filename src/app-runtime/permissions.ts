import type { AccessLevel, AppDefinition } from "./types.js";
import { meetsAccessLevel } from "./validation.js";

export type AccessResult = { allowed: boolean; reason?: string };

export function checkAccess(
  def: AppDefinition | null,
  actor: string,
  requiredLevel: AccessLevel,
): AccessResult {
  if (!def) return { allowed: false, reason: "App not found" };

  if (def.permissions.owner === actor) return { allowed: true };

  if (def.status === "suspended") return { allowed: false, reason: "App is suspended" };
  if (def.status === "archived" && requiredLevel !== "read") return { allowed: false, reason: "App is archived (read-only)" };

  if (def.permissions.visibility === "public" && requiredLevel === "read") return { allowed: true };

  if (def.permissions.visibility === "team" && requiredLevel === "read") return { allowed: true };
  if (def.permissions.visibility === "team" && def.permissions.allowedAgents.includes(actor)) {
    const level = def.permissions.accessLevels[actor] || "read";
    if (meetsAccessLevel(level, requiredLevel)) return { allowed: true };
  }

  if (def.permissions.allowedAgents.includes(actor)) {
    const level = def.permissions.accessLevels[actor] || "read";
    if (meetsAccessLevel(level, requiredLevel)) return { allowed: true };
  }

  if (actor === "user") return { allowed: true };

  return { allowed: false, reason: `Insufficient permissions (need ${requiredLevel})` };
}
