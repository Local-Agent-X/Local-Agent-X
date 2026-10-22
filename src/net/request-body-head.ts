import type { IncomingMessage } from "node:http";

/** A body is judged on its head, like a multipart file part at send. */
export const REQUEST_BODY_HEAD_CAP = 256 * 1024;

/** Read up to `cap` bytes of a request body and pause it there; the caller
 *  writes the head on, then pipes the rest. A body that ends first resolves
 *  with all of it. */
export function readBodyHead(request: IncomingMessage, cap = REQUEST_BODY_HEAD_CAP): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      request.off("data", onData);
      request.off("end", done);
      request.off("error", reject);
      request.pause();
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= cap) done();
    };
    request.on("data", onData);
    request.once("end", done);
    request.once("error", reject);
  });
}
