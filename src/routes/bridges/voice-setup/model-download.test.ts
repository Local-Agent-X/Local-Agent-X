// POST /api/voices/setup/model-download starts a local speech model's
// download and answers at once, so picking the Local voice tier fetches
// Parakeet (~670 MB) up front instead of the first voice session sitting
// silent while it arrives. Progress is read back from /status sttModels.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

const fetchState = vi.hoisted(() => ({
  cached: false,
  localOnly: false,
  started: [] as string[],
}));

vi.mock("../../../voice/whisper-model-fetch.js", async (orig) => {
  const real = await orig<typeof import("../../../voice/whisper-model-fetch.js")>();
  return {
    ...real,
    whisperModelExists: () => fetchState.cached,
    ensureWhisperModelDownloaded: vi.fn(async (_p: unknown, opts?: { variant?: string }) => {
      fetchState.started.push(String(opts?.variant));
      return new Promise(() => {});
    }),
    whisperDownloadState: (v: string) => ({
      cached: fetchState.cached,
      downloading: fetchState.started.includes(v),
      overallPct: 0,
    }),
  };
});
vi.mock("../../../local-only-policy.js", async (orig) => ({
  ...(await orig<typeof import("../../../local-only-policy.js")>()),
  isLocalOnlyMode: () => fetchState.localOnly,
}));

const { handleSpeechModelRoutes } = await import("./speech-models.js");

function makeReq(body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  return req;
}
function makeRes() {
  const res = {
    statusCode: 0, body: "",
    setHeader() {}, writeHead(s: number) { res.statusCode = s; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}
async function post(body: unknown) {
  const res = makeRes();
  const url = new URL("http://localhost/api/voices/setup/model-download");
  await handleSpeechModelRoutes("POST", url, makeReq(body) as never, res as never, {} as never, "operator" as never);
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

beforeEach(() => {
  fetchState.cached = false;
  fetchState.localOnly = false;
  fetchState.started = [];
});

describe("POST /api/voices/setup/model-download", () => {
  it("starts the download and answers before it finishes", async () => {
    const r = await post({ model: "parakeet-v3" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ downloading: true });
    expect(fetchState.started).toEqual(["parakeet-v3"]);
  });

  it("does nothing for a model already on disk", async () => {
    fetchState.cached = true;
    const r = await post({ model: "parakeet-v3" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cached: true });
    expect(fetchState.started).toEqual([]);
  });

  it("refuses a name that is not a local speech model", async () => {
    const r = await post({ model: "../../etc/passwd" });
    expect(r.status).toBe(400);
    expect(fetchState.started).toEqual([]);
  });

  it("says why in strict local-only mode instead of failing silently", async () => {
    fetchState.localOnly = true;
    const r = await post({ model: "parakeet-v3" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/local-only/i);
    expect(fetchState.started).toEqual([]);
  });
});
