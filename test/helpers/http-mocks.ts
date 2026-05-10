import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Build a fake IncomingMessage that yields the given JSON body to readBody/safeParseBody. */
export function mockJsonRequest(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const json = JSON.stringify(body);
  const stream = Readable.from([Buffer.from(json, "utf-8")]) as unknown as IncomingMessage;
  // Both ends of the IncomingMessage interface — only the bits server-utils touches.
  (stream as unknown as { headers: Record<string, string> }).headers = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(json)),
    ...headers,
  };
  (stream as unknown as { method: string }).method = "POST";
  return stream;
}

export interface CapturedResponse {
  status: number | null;
  headers: Record<string, string | number | string[]>;
  body: string;
  ended: boolean;
  res: ServerResponse;
}

/** Build a fake ServerResponse that captures writeHead/write/end calls. */
export function mockResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    status: null,
    headers: {},
    body: "",
    ended: false,
    res: null as unknown as ServerResponse,
  };
  const fake: Partial<ServerResponse> & Record<string, unknown> = {
    writableEnded: false,
    destroyed: false,
    writeHead(this: ServerResponse, status: number, headers?: Record<string, string | number | string[]>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      return this;
    },
    setHeader(name: string, value: string | number | string[]) {
      captured.headers[name] = value;
    },
    write(chunk: unknown) {
      captured.body += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        captured.body += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
      }
      captured.ended = true;
      (this as unknown as { writableEnded: boolean }).writableEnded = true;
    },
  };
  captured.res = fake as ServerResponse;
  return captured;
}
