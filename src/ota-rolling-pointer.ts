/**
 * Rolling-channel target resolution.
 *
 * The rolling updater used to resolve `main` HEAD and hand those bytes to the
 * build gate running on the user's machine. That made every installed client
 * the first place a broken push was discovered: one commit that fails
 * `npm run build` is rejected on every machine at once, and Check-for-Updates
 * stays red until a fix lands upstream. CI already builds the same commit, so
 * the proof belongs there, before the bytes are offered to anyone.
 *
 * The publisher (.github/workflows/rolling-source.yml) builds a commit, uploads
 * its checksum-verified source asset, and only then advances this pointer.
 * Clients resolve the pointer instead of the branch head, so an unbuildable
 * push is never offered — installs simply stay on the last proven commit and
 * the failure is visible only in CI, where it belongs.
 */

export const ROLLING_POINTER_ASSET = "rolling-source-latest.json";
export const ROLLING_POINTER_SCHEMA = 1;

export interface RollingPointer {
  schemaVersion: number;
  commit: string;
  subject: string;
  publishedAt: string;
}

export function rollingPointerUrl(repoOwner: string, repoName: string): string {
  return `https://github.com/${repoOwner}/${repoName}/releases/download/rolling/${ROLLING_POINTER_ASSET}`;
}

/**
 * Parse a published pointer, accepting anything whose commit is addressable.
 *
 * Deliberately liberal about every field except `commit`. The pointer is the
 * ONLY route a rolling install has to new code, so a client that refuses an
 * unfamiliar schemaVersion could never update to the client that understands
 * it — a permanent brick, self-inflicted by a future format bump. A 40-char
 * sha is the whole contract; everything else is display metadata.
 */
export function parseRollingPointer(raw: string): RollingPointer {
  let data: Partial<RollingPointer>;
  try {
    data = JSON.parse(raw) as Partial<RollingPointer>;
  } catch {
    throw new Error("Update rejected: the published rolling pointer is not valid JSON.");
  }
  if (!data || typeof data !== "object") {
    throw new Error("Update rejected: the published rolling pointer is not an object.");
  }
  const commit = typeof data.commit === "string" ? data.commit.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Update rejected: the published rolling pointer names no resolvable commit.");
  }
  return {
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : ROLLING_POINTER_SCHEMA,
    commit,
    subject: typeof data.subject === "string" ? data.subject : "",
    publishedAt: typeof data.publishedAt === "string" ? data.publishedAt : "",
  };
}

/**
 * Resolve the newest CI-proven commit. Fails closed: a missing, unreachable, or
 * malformed pointer leaves the install where it is rather than falling back to
 * an unproven branch head.
 */
export async function fetchRollingPointer(
  repoOwner: string,
  repoName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RollingPointer> {
  const url = rollingPointerUrl(repoOwner, repoName);
  const res = await fetchImpl(url, { redirect: "follow" });
  if (res.status === 404) {
    throw new Error(
      "No verified rolling build has been published yet. Updates resume once CI publishes a build that passes.",
    );
  }
  if (!res.ok) {
    throw new Error(`Update check failed: could not read the rolling pointer (HTTP ${res.status}).`);
  }
  return parseRollingPointer(await res.text());
}
