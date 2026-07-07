import { basename, dirname, resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { realpathDeep } from "../workspace/paths.js";

const CONNECTOR_FILE_RE = /^[a-z0-9][a-z0-9_-]*\.json$/;

// realpathDeep both sides: a symlinked prefix (macOS /var → /private/var, a
// junctioned workspace) must not make the manifest dir and cwd compare unequal.
function norm(p: string): string {
  return realpathDeep(resolve(p)).replace(/\\/g, "/").toLowerCase();
}

function isConnectorManifestDir(dir: string): boolean {
  const n = norm(dir);
  return (
    n === norm(resolve(process.cwd(), "connectors")) ||
    n === norm(resolve(getLaxDir(), "connectors"))
  );
}

/** Connector manifests are live data, not ordinary workspace files. The proxy
 *  loads them from the LAX data dir and validates them through
 *  connector_create/saveConnectorManifest. A direct write to repo/connectors
 *  looks successful to the model but is invisible to the live route — exactly
 *  the "claimed fixed, still broken" failure this guard prevents. */
export function connectorManifestWriteRejection(filePath: string): string | null {
  if (!CONNECTOR_FILE_RE.test(basename(filePath))) return null;
  if (!isConnectorManifestDir(dirname(filePath))) return null;

  return (
    `BLOCKED: Connector manifests are not written with file tools. ` +
    `Use connector_create({ name, upstream, auth, allow }) so the manifest is ` +
    `validated and saved where /api/connectors/<name>/... actually loads it. ` +
    `Direct file path ${filePath} would not be reliable evidence that the connector works.`
  );
}
