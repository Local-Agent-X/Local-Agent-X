import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse } from "../../../server-utils.js";
import { handleTierProbe } from "./tier-probe.js";
import { handleChatterboxProxy } from "./chatterbox-proxy.js";
import { handleSovitsProxy } from "./sovits-proxy.js";
import { handleTrainingList } from "./training-list.js";
import { handleTrainingLog } from "./training-log.js";
import { handleTrainingDelete } from "./training-delete.js";
import { handleTrainingStart } from "./training-start.js";

export const handleVoiceCloneRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // /api/voices/tier — capability probe; reports both Chatterbox + SoVITS
  if (method === "GET" && url.pathname === "/api/voices/tier") {
    await handleTierProbe(json);
    return true;
  }

  // /api/voices/chatterbox/* → Chatterbox sidecar (:7010)
  if (url.pathname === "/api/voices/chatterbox" || url.pathname.startsWith("/api/voices/chatterbox/")) {
    await handleChatterboxProxy(method, url.pathname, req, json);
    return true;
  }

  // GET /api/voices/sovits/training/list — list incomplete training runs
  if (method === "GET" && url.pathname === "/api/voices/sovits/training/list") {
    await handleTrainingList(json);
    return true;
  }

  // GET /api/voices/sovits/training/<exp_name>/log[?since=N]
  if (method === "GET" && url.pathname.match(/^\/api\/voices\/sovits\/training\/[^/]+\/log$/)) {
    await handleTrainingLog(url, json);
    return true;
  }

  // DELETE /api/voices/sovits/training/<exp_name> — purge a stale run
  if (method === "DELETE" && url.pathname.startsWith("/api/voices/sovits/training/")) {
    await handleTrainingDelete(url, json);
    return true;
  }

  // POST /api/voices/sovits/train — kick off training pipeline (SSE stream)
  if (method === "POST" && url.pathname === "/api/voices/sovits/train") {
    await handleTrainingStart(req, res, json);
    return true;
  }

  // /api/voices/sovits/* → SoVITS clones sidecar (:7012)
  // Listed AFTER /api/voices/sovits/train so the training route wins.
  if (url.pathname === "/api/voices/sovits" || url.pathname.startsWith("/api/voices/sovits/")) {
    await handleSovitsProxy(method, url.pathname, req, json);
    return true;
  }

  return false;
};
