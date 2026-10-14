export interface SecretEntry {
  name: string;
  value: string;       // encrypted at rest, decrypted in memory
  service?: string;    // e.g. "github", "slack", "linear"
  account?: string;    // username/email paired with this password
  url?: string;        // login page URL
  notes?: string;      // free-form user-visible notes
  origin?: string;     // origin derived from url (scheme://host[:port]); authoritative for fill gating
  createdBySession?: string; // agent session that captured this secret; enables auto-approval of same-session reuse
  approvedDestinations?: ApprovedDestination[]; // user-approved (secret, destination) pairs; see destinationDecision
  addedAt: number;
  updatedAt: number;
}

/** A destination the user approved a secret for: a key from normalizeDestination. */
export interface ApprovedDestination { origin: string; approvedAt: number }

export interface SecretMetadata {
  service?: string;
  account?: string;
  url?: string;
  notes?: string;
  origin?: string;
  createdBySession?: string;
}

/** Metadata view returned to callers — never includes the plaintext value. */
export interface SecretMetaView {
  name: string;
  service?: string;
  account?: string;
  url?: string;
  notes?: string;
  origin?: string;
  createdBySession?: string;
  approvedDestinations?: ApprovedDestination[];
  addedAt: number;
  updatedAt: number;
}

export interface SecretsFileEntry {
  name: string;
  service?: string;
  account?: string;
  url?: string;
  notes?: string;
  origin?: string;
  createdBySession?: string;
  approvedDestinations?: ApprovedDestination[];
  /** The field's name before ADR 0005; read by the loader, never written. */
  approvedFills?: ApprovedDestination[];
  addedAt: number;
  updatedAt: number;
  encrypted: string; // hex: iv(12) + authTag(16) + ciphertext
}

export interface SecretsFile {
  /** 1: approvals were fill origins only; 2: destinations, with the connector bindings seeded. */
  version: 1 | 2;
  secrets: SecretsFileEntry[];
}
