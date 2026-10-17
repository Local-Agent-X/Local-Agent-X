// The LAX data directory, for the ~200 server modules that import it by this
// name. The resolver itself is part of the desktop↔server contract
// (src/desktop-contract/data-dir.ts), so the desktop app and the server agree
// on where the pidfile, config and rollback journal live when LAX_DATA_DIR
// relocates them.

import { laxDataDir } from "./desktop-contract/data-dir.js";

export const getLaxDir = laxDataDir;
