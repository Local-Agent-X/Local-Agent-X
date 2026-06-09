export interface SecretEntry {
  name: string;
  value: string;       // encrypted at rest, decrypted in memory
  service?: string;    // e.g. "github", "slack", "linear"
  account?: string;    // username/email paired with this password
  url?: string;        // login page URL
  notes?: string;      // free-form user-visible notes
  origin?: string;     // origin derived from url (scheme://host[:port]); authoritative for fill gating
  createdBySession?: string; // agent session that captured this secret; enables auto-approval of same-session reuse
  approvedFills?: Array<{ origin: string; approvedAt: number }>; // user-approved (secret, origin) pairs for automated fill
  addedAt: number;
  updatedAt: number;
}

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
  approvedFills?: Array<{ origin: string; approvedAt: number }>;
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
  approvedFills?: Array<{ origin: string; approvedAt: number }>;
  addedAt: number;
  updatedAt: number;
  encrypted: string; // hex: iv(12) + authTag(16) + ciphertext
}

export interface SecretsFile {
  version: 1;
  secrets: SecretsFileEntry[];
}
