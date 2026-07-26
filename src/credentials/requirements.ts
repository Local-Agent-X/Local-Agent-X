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
   * rest.
   *
   * Read through isSecretRequirement() below, whose consumers are
   * missingSecretCredentials() — the shared gate behind BOTH the integrations
   * agent context (src/integrations/registry.ts advertisable()) and the plugin
   * secret lifecycle — and the install route
   * (src/routes/bridges/integrations.ts), which skips the vault write for a
   * non-secret requirement rather than encrypting it.
   */
  secret?: boolean;
  /**
   * Whether the component is unusable without this value. Absent means true —
   * same shape as `secret`, so declaring the field narrows nothing until a
   * declaration opts out.
   *
   * `false` marks a value that unlocks PART of an integration: email's IMAP_*
   * set is what reading mail needs, and a send-only user legitimately has none
   * of it. Independent of `secret`: IMAP_PASS is a secret the user may not have,
   * SMTP_HOST is a non-secret they must supply.
   *
   * Read through isRequiredRequirement() below. Its consumers are
   * missingSecretCredentials() — the shared gate that must not hide a working
   * send-only mailbox from the agent — the install route
   * (src/routes/bridges/integrations.ts), which must not reject an install that
   * omits it, and the Settings modal, which must not block submit on a blank
   * one. NOT accepted by parseCredentialRequirements(): letting a plugin bundle
   * declare a secret it can run without is a manifest-contract change, and is
   * kept out for the same reason `secret` is.
   */
  required?: boolean;
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
 * A requirement is required-by-default; only an explicit `required: false` says
 * the component still works without it.
 */
export function isRequiredRequirement(requirement: CredentialRequirement): boolean {
  return requirement.required !== false;
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

/**
 * Names of the requirements the availability port cannot currently satisfy.
 * A pure presence check over exactly the list it is handed — it asks nothing
 * about whether a requirement BELONGS in the vault, or about whether its
 * absence blocks anything.
 *
 * NO PRODUCTION CALLER, AND EXPORTED ANYWAY. Its only consumers are
 * missingSecretCredentials() below and requirements.test.ts. Kept exported
 * deliberately, for one reason: it is the CONTROL in that test file. Every case
 * that proves the vault policy is doing work asserts the pair — the pure check
 * reports SMTP_HOST/IMAP_PASS as absent, and missingSecretCredentials() reports
 * them as not blocking. Without a reachable pure check those tests could only
 * assert the policy's own answer, and a regression that quietly widened
 * isSecretRequirement()/isRequiredRequirement() into no-ops would still pass
 * them. Inlining it would trade a documented unused export for a weaker
 * regression net over the exact rule that hid a working send-only mailbox.
 *
 * DO NOT USE THIS AS A GATE. "Is this value present?" is not "can this component
 * run?", and answering the second with the first is the divergence this module
 * exists to remove. Anything asking whether an integration or plugin has what it
 * needs wants missingSecretCredentials() below — no exceptions, which is why
 * there are no other callers and why a new one is a review flag rather than a
 * convenience.
 */
export function missingCredentials(
  requirements: CredentialRequirement[],
  availability: SecretAvailabilityPort | undefined,
): string[] {
  return requirements
    .filter((item) => !availability?.has(item.name))
    .map((item) => item.name);
}

/**
 * Names of the REQUIRED, VAULT-BACKED requirements the availability port cannot
 * satisfy.
 *
 * This module is the ONE owner of the policy "which requirements count against
 * the vault", and this is the function that expresses it. Two declarations opt a
 * value out, for different reasons, and a value is counted only if BOTH say yes:
 *  - `secret: false` marks a non-secret config value (SMTP_HOST is the
 *    documented example) that must not be encrypted at rest, so its absence from
 *    the vault is the normal state and can never block anything;
 *  - `required: false` marks a secret the component runs without (email's
 *    IMAP_PASS: a send-only user has no IMAP password and never will), so its
 *    absence is a REDUCED capability, not a broken one. Counting it hid a
 *    working mailbox from the agent entirely.
 *
 * Every gate that asks "does this have what it needs to run?" — the integrations
 * agent-context gate, the plugin secret lifecycle — consumes THIS rather than
 * re-deriving the filter locally, because two subsystems answering that question
 * two ways is exactly the divergence this shared module exists to remove.
 */
export function missingSecretCredentials(
  requirements: CredentialRequirement[],
  availability: SecretAvailabilityPort | undefined,
): string[] {
  return missingCredentials(
    requirements.filter((item) => isSecretRequirement(item) && isRequiredRequirement(item)),
    availability,
  );
}
