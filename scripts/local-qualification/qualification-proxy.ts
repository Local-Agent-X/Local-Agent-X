import { createServer, type Server, type ServerResponse } from "node:http";

const REQUEST_TIMEOUT_MS = 180_000;
const ALLOWED = new Set([
  "GET /api/version",
  "GET /api/tags",
  "GET /api/ps",
  "POST /api/show",
  "POST /api/generate",
  "POST /v1/chat/completions",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

export interface QualificationProxyCounters {
  certification: number;
  background: number;
  forbidden: number;
}

export interface QualificationProxy {
  readonly url: string;
  close(): Promise<void>;
}

function deny(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) return;
  response.shouldKeepAlive = false;
  response.writeHead(403, { "Content-Type": "application/json", Connection: "close" });
  response.end('{"error":"forbidden"}');
}

function isCertificationBody(body: Buffer): boolean {
  const value = body.toString("utf8");
  return value.includes("LAX_CERT_")
    || value.includes("lax_certification_probe")
    || value.includes('"name":"certification"');
}

function isCompactionBody(body: Buffer): boolean {
  return body.toString("utf8").includes("Conversation segment to summarize");
}

export async function startQualificationProxy(
  upstreamBase: URL,
  counters: QualificationProxyCounters,
  signal: AbortSignal,
  onForbidden?: (request: string) => void,
): Promise<QualificationProxy> {
  let closing = false;
  let closePromise: Promise<void> | null = null;
  const controllers = new Set<AbortController>();
  const inflight = new Set<Promise<void>>();
  const server: Server = createServer((request, response) => {
    const work = (async () => {
      const rawTarget = request.url ?? "";
      const key = `${request.method ?? ""} ${rawTarget}`;
      if (closing || !ALLOWED.has(key)) {
        counters.forbidden += 1;
        onForbidden?.(key);
        request.resume();
        deny(response);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (key === "POST /v1/chat/completions" && isCertificationBody(body)) counters.certification += 1;
      if (key === "POST /api/generate" && isCompactionBody(body)) counters.background += 1;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const target = new URL(rawTarget, upstreamBase);
        const upstream = await fetch(target, {
          method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).filter(
            ([name, value]) => typeof value === "string" && !HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
          )) as Record<string, string>,
          body: body.length > 0 ? body : undefined,
          redirect: "manual",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if ((upstream.status >= 300 && upstream.status < 400) || upstream.headers.has("location")) {
          counters.forbidden += 1;
          onForbidden?.(`${key} -> redirect`);
          deny(response);
          return;
        }
        response.writeHead(upstream.status, Object.fromEntries([...upstream.headers.entries()].filter(
          ([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
        )));
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
      } finally {
        controllers.delete(controller);
      }
    })().catch(() => {
      if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
    });
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    const abort = () => server.close(() => reject(signal.reason));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => signal.aborted ? abort() : resolve());
    signal.addEventListener("abort", abort, { once: true });
    server.once("close", () => signal.removeEventListener("abort", abort));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.allSettled([...inflight]);
      })();
      return closePromise;
    },
  };
}
