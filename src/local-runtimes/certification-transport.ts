import type { CertificationTransport } from "./certification-types.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

async function readBoundedBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      try { await reader.cancel("certification response exceeded size limit"); } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const localCertificationTransport: CertificationTransport = async (request) => {
  const base = request.endpoint.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request.body),
    redirect: "manual",
    signal: request.signal,
  });
  return { status: response.status, body: await readBoundedBody(response) };
};
