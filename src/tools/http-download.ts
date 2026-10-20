// http_request's save_to: the response body written to a file instead of
// returned. This is the download path. Where no cage holds egress the shell
// network clients (curl, wget) stay refused, and their refusal names this way
// out (shell-command-rules.ts); without it a model that needed a tarball, a
// wheel or a dataset on disk had no sanctioned way to get one. The bytes come
// through the same SSRF check, DNS pinning, redirect re-check and audit as any
// request, and the path was vetted for writing before the call ran (the policy
// row's pathArgs).

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Response } from "undici";

/** A download past this size is stopped and nothing is kept. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3;

/** Stream `res`'s body to `path` (written whole or not at all); returns its size in bytes. */
export async function saveResponseBody(res: Response, path: string, signal?: AbortSignal, limit = MAX_DOWNLOAD_BYTES): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.part`;
  let bytes = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > limit ? new Error(`the download passed ${limit} bytes and was stopped`) : null, chunk);
    },
  });
  try {
    const body = res.body ? Readable.fromWeb(res.body as WebReadableStream) : Readable.from([]);
    await pipeline(body, counted, createWriteStream(partial), { signal });
    await rename(partial, path);
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }
  return bytes;
}
