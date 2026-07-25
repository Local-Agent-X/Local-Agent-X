// Neutral credential-requirement declaration: what a component NEEDS, as
// opposed to src/secrets-types.ts which describes what is STORED in the vault.
//
// The plugin system solved this first and owns the tested lifecycle; this
// module is that mechanism lifted verbatim so other subsystems (integrations
// next) consume it instead of forking a parallel one. src/plugin-system's
// manifest.ts and secret-requirements.ts re-export from here, so every existing
// plugin call site is unchanged.

export interface CredentialRequirement {
  name: string;
  service?: string;
  description?: string;
  /**
   * Whether this value belongs in the encrypted vault. Absent means true — a
   * requirement is a secret unless it says otherwise. `false` marks a
   * non-secret config value (e.g. SMTP_HOST) that must NOT be encrypted at
   * rest. Declared here only; no consumer reads it yet.
   */
  secret?: boolean;
  /** Where the user goes to obtain this credential. */
  url?: string;
}

export interface SecretAvailabilityPort {
  has(name: string): boolean;
  onAvailabilityChange?(listener: (change: { type: "available" | "deleted"; name: string }) => void): () => void;
}

/**
 * A requirement is secret-by-default; only an explicit `secret: false` opts a
 * value out of the encrypted vault.
 */
export function isSecretRequirement(requirement: CredentialRequirement): boolean {
  return requirement.secret !== false;
}

/**
 * Parses declared credential requirements. The accepted fields and the error
 * wording are the plugin bundle contract — frozen here on purpose. `secret` and
 * `url` are part of the type but are NOT yet accepted by this parser; admitting
 * them would relax the plugin manifest contract, which this lift must not do.
 */
export function parseCredentialRequirements(value: unknown): CredentialRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Plugin bundle secret contributions must be a non-empty array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Plugin bundle secret requirement must be an object");
    }
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !["name", "service", "description"].includes(key))) {
      throw new Error("Plugin bundle secret requirement contains an unknown field");
    }
    if (typeof raw.name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(raw.name)) {
      throw new Error("Plugin bundle secret requirement name must be canonical");
    }
    if (seen.has(raw.name)) throw new Error("Plugin bundle contains duplicate secret requirements");
    seen.add(raw.name);
    if (raw.service !== undefined && (typeof raw.service !== "string" || !raw.service.trim())) {
      throw new Error("Plugin bundle secret requirement service is invalid");
    }
    if (raw.description !== undefined && (typeof raw.description !== "string" || !raw.description.trim())) {
      throw new Error("Plugin bundle secret requirement description is invalid");
    }
    return {
      name: raw.name,
      ...(raw.service !== undefined ? { service: raw.service as string } : {}),
      ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    };
  });
}

/** Names of the requirements the availability port cannot currently satisfy. */
export function missingCredentials(
  requirements: CredentialRequirement[],
  availability: SecretAvailabilityPort | undefined,
): string[] {
  return requirements
    .filter((item) => !availability?.has(item.name))
    .map((item) => item.name);
}
