import { describe, it, expect } from "vitest";
import ts from "typescript";
import { scanSourceForNetworkUse } from "./network-primitives.js";

const usesOf = (code: string) =>
  scanSourceForNetworkUse(ts.createSourceFile("probe.ts", code, ts.ScriptTarget.Latest, true)).uses;

describe("scanSourceForNetworkUse", () => {
  it("a type, a type-only import, or a script in a string is not a use", () => {
    expect(usesOf(`import type { IncomingMessage } from "node:http"; export function f(r: IncomingMessage) { return r; }`)).toEqual([]);
    expect(usesOf(`import { IncomingMessage } from "http"; export const f = (r: IncomingMessage) => r;`)).toEqual([]);
    expect(usesOf(`export const fetcher: typeof fetch | null = null;`)).toEqual([]);
    expect(usesOf(`export const script = 'require("net").connect(80); fetch("https://x")';`)).toEqual([]);
  });

  it("tells a listener from a dialer", () => {
    expect(usesOf(`import { createServer } from "node:http"; createServer(() => {}).listen(0);`)).toEqual(["server"]);
    expect(usesOf(`import { request } from "https"; request("https://x");`)).toEqual(["outbound"]);
    expect(usesOf(`import * as net from "node:net"; net.createServer(); net.connect(1);`)).toEqual(["outbound", "server"]);
    expect(usesOf(`import { isIP } from "node:net"; export const ok = isIP("1.2.3.4");`)).toEqual([]);
  });

  it("the global fetch is a use, whether called or handed on", () => {
    expect(usesOf(`export async function f() { return fetch("https://x"); }`)).toEqual(["outbound"]);
    expect(usesOf(`export function make(impl: typeof fetch = fetch) { return impl; }`)).toEqual(["outbound"]);
    expect(usesOf(`export const f = () => globalThis.fetch("https://x");`)).toEqual(["outbound"]);
    expect(usesOf(`export const deps = { fetch };`)).toEqual(["outbound"]);
  });

  it("a local binding or a property named fetch is not the global", () => {
    expect(usesOf(`export function f(fetch: (u: string) => void) { fetch("x"); }`)).toEqual([]);
    expect(usesOf(`const fetch = (u: string) => u; export const r = fetch("x");`)).toEqual([]);
    expect(usesOf(`export const r = (o: { fetch(): void }) => { o.fetch(); return { fetch: 1 }; };`)).toEqual([]);
    expect(usesOf(`function a(fetch: () => void) { fetch(); } export function b() { return fetch("x"); } a(() => {});`)).toEqual(["outbound"]);
  });

  it("a dynamic import or a createRequire load is as much a use as an import", () => {
    expect(usesOf(`export async function f() { const { createServer } = await import("node:net"); createServer(); }`)).toEqual(["server"]);
    expect(usesOf(`export async function f() { return (await import("undici")).fetch("https://x"); }`)).toEqual(["outbound"]);
    expect(usesOf(`import { createRequire } from "node:module"; const require = createRequire(import.meta.url); export const ws = require("ws");`)).toEqual(["outbound"]);
  });

  it("ws: a server class is a listener, a client socket dials, a readyState constant is neither", () => {
    expect(usesOf(`import { WebSocketServer, WebSocket } from "ws"; new WebSocketServer({ noServer: true }); export const open = (s: WebSocket) => s.readyState === WebSocket.OPEN;`)).toEqual(["server"]);
    expect(usesOf(`import { WebSocket } from "ws"; export const s = new WebSocket("wss://x");`)).toEqual(["outbound"]);
    expect(usesOf(`import WebSocket from "ws"; export const s = new WebSocket("wss://x");`)).toEqual(["outbound"]);
  });

  it("a client package is a use; Playwright loads the browser, and its request context dials", () => {
    expect(usesOf(`import { createTransport } from "nodemailer"; createTransport({});`)).toEqual(["outbound"]);
    expect(usesOf(`import { chromium } from "playwright"; export const b = chromium.launch();`)).toEqual(["browser"]);
    expect(usesOf(`import type { Page } from "playwright"; export const get = (p: Page, u: string) => p.request.get(u);`)).toEqual(["outbound"]);
    expect(usesOf(`export const get = (p: { request: { get(u: string): void } }, u: string) => p.request.get(u);`)).toEqual([]);
  });
});
