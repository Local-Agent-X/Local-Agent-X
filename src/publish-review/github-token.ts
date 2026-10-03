/**
 * The token the user connected the GitHub integration with, for signing in the
 * pre-publish push dry run. Which vault entry that is belongs to the user's
 * integration setup (Settings → Integrations, and a saved rename of its
 * primary credential), so it is read through the registry that applies that
 * setup and never taken from anything the agent supplies. The registry is
 * read from the data directory it saves to on every change.
 */
import { IntegrationRegistry } from "../integrations/registry.js";
import { getLaxDir } from "../lax-data-dir.js";
import { getSecretsStoreSingleton } from "../secrets.js";

export interface GithubToken {
  /** The vault entry, for naming the token where its value must not appear. */
  name: string;
  value: string;
}

/** The connected GitHub integration's token, or null when the integration is
 *  not set up, is switched off, or its credential is not in the vault. */
export function githubIntegrationToken(): GithubToken | null {
  const store = getSecretsStoreSingleton();
  if (!store) return null;
  const github = new IntegrationRegistry(getLaxDir(), store).get("github");
  if (!github?.installed || !github.enabled) return null;
  const value = store.get(github.secretName);
  return value ? { name: github.secretName, value } : null;
}
