import type { DeploymentProfile, ProfileDefaults } from "./types.js";

// ── Deployment Profile Defaults ──
// Each profile bundles sane defaults for its target audience.
// "home"       — single user, max ease, secure but hands-off
// "dev"        — local development, relaxed policies, verbose logs
// "enterprise" — locked down, full audit, confirm everything
export const PROFILE_DEFAULTS: Record<DeploymentProfile, ProfileDefaults> = {
  home: {
    sandboxMode: "guarded",
    toolApproval: "auto",
    retentionDays: 90,
    autoUpdate: true,
    networkExposure: "localhost",
    logLevel: "detailed",
  },
  dev: {
    sandboxMode: "guarded",
    toolApproval: "auto",
    retentionDays: 90,
    autoUpdate: true,
    networkExposure: "localhost",
    logLevel: "detailed",
  },
  enterprise: {
    sandboxMode: "docker",
    toolApproval: "confirm-all",
    retentionDays: 30,
    autoUpdate: false,
    networkExposure: "localhost",
    logLevel: "full-audit",
  },
};
