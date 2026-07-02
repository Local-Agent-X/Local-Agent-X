// Phone-side render-verify instrumentation. The desktop preview iframe gets
// the error-capture script injected by the IDE UI (public/js/apps-ide-errors.js),
// but a phone loading the app over the broker tunnel never runs that UI — so
// the server injects the SAME capture core (public/js/apps-error-pipe-core.js)
// into tunneled app HTML, with a fetch-POST emitter targeting the runtime-error
// ingress under /api/apps (already inside the broker device allowlist). One
// capture source, two emitters — never fork the core.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("server.error-pipe");

let cachedCore: string | null = null;

function coreSource(publicDir: string): string {
  if (cachedCore === null) {
    try {
      cachedCore = readFileSync(join(publicDir, "js", "apps-error-pipe-core.js"), "utf-8");
    } catch (e) {
      logger.warn(`error-pipe core unreadable, phone instrumentation off: ${(e as Error).message}`);
      cachedCore = "";
    }
  }
  return cachedCore;
}

/** Test-only — drop the cached core so a test can vary publicDir. */
export function _resetErrorPipeCache(): void {
  cachedCore = null;
}

/** <script> block installing the capture core with a fetch emitter that posts
 *  each error to this app's runtime-error ingress. Empty string when the core
 *  file is missing (instrumentation degrades silently; the app still serves). */
export function phoneErrorPipeScript(publicDir: string, appId: string): string {
  const core = coreSource(publicDir);
  if (!core || !/^[a-zA-Z0-9_-]+$/.test(appId)) return "";
  const endpoint = `/api/apps/${appId}/runtime-error`;
  return (
    "<script>" + core +
    `;__laxInstallErrorPipe(function(payload){try{fetch(${JSON.stringify(endpoint)},` +
    `{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),keepalive:true})` +
    `.catch(function(){});}catch(e){}});</script>`
  );
}
