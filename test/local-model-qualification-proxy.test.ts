import { request } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { RealQualificationDriver } from "../scripts/local-qualification/real-driver.js";
import { runQualification } from "../scripts/local-qualification/run.js";
import { FakeOllamaQualificationService } from "./helpers/fake-ollama-qualification.js";

async function rawProxyRequest(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const base = new URL(baseUrl);
  const body = method === "GET" || method === "HEAD" ? "" : "{}";
  return await new Promise<number>((resolveRequest, reject) => {
    const req = request({
      hostname: base.hostname,
      port: Number(base.port),
      method,
      path,
      agent: false,
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveRequest(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end(body);
  });
}

describe("local model qualification proxy", () => {
  it("rejects every non-allowlisted method and raw route without forwarding", async () => {
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    let proxyUrl = "";
    let upstreamBeforeAttacks = 0;
    let countedAfterAttacks = 0;
    const forbiddenRoutes: string[] = [];
    const attacks: Array<[string, string]> = [
      ["POST", "/api/pull"],
      ["POST", "/api/pull?stream=true"],
      ["POST", "/api/pull/"],
      ["POST", "//api/pull"],
      ["POST", "/%61pi/pull"],
      ["POST", "/api/a/../pull"],
      ["POST", "/API/PULL"],
      ["POST", "/api/create"],
      ["POST", "/api/copy"],
      ["DELETE", "/api/delete"],
      ["POST", "/api/push"],
      ["PUT", "/api/blobs/sha256:abc"],
      ["GET", "/api/show"],
      ["GET", "/api/tags?verbose=1"],
    ];
    class AttackingDriver extends RealQualificationDriver {
      override async start(signal: AbortSignal): Promise<void> {
        await super.start(signal);
        upstreamBeforeAttacks = service.received.length;
        for (const [method, path] of attacks) {
          const before = this.forbiddenRequests();
          expect(await rawProxyRequest(proxyUrl, method, path), `${method} ${path}`).toBe(403);
          expect(this.forbiddenRequests(), `${method} ${path} was not counted`).toBe(before + 1);
        }
        countedAfterAttacks = this.forbiddenRequests();
      }
    }
    try {
      const driver = new AttackingDriver(endpoint, service.model, resolve("."), {
        onProxyUrl: (url) => { proxyUrl = url; },
        onForbiddenRoute: (route) => forbiddenRoutes.push(route),
      });
      const scorecard = await runQualification(driver, { stageTimeoutMs: 90_000 });
      expect(scorecard.ok).toBe(false);
      expect(scorecard.stages[0]).toMatchObject({ name: "isolated_boot", ok: false, failure: "failed" });
      expect(countedAfterAttacks, forbiddenRoutes.join(" | ")).toBe(attacks.length);
      expect(driver.forbiddenRequests()).toBe(attacks.length);
      expect(service.counts.forbidden).toBe(0);
      expect(service.received).toHaveLength(upstreamBeforeAttacks);
      expect(JSON.stringify(scorecard)).not.toMatch(/pull\?|proxy_forwarded|blobs|create|delete/i);
    } finally {
      await service.close();
    }
  }, 180_000);

  it("rejects an upstream redirect without following its Location", async () => {
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    let proxyUrl = "";
    class RedirectingDriver extends RealQualificationDriver {
      override async start(signal: AbortSignal): Promise<void> {
        await super.start(signal);
        expect(await rawProxyRequest(proxyUrl, "GET", "/api/version", {
          "X-Qualification-Test-Redirect": "1",
        })).toBe(403);
      }
    }
    try {
      const driver = new RedirectingDriver(endpoint, service.model, resolve("."), {
        onProxyUrl: (url) => { proxyUrl = url; },
      });
      const scorecard = await runQualification(driver, { stageTimeoutMs: 90_000 });
      expect(scorecard.stages[0]).toMatchObject({ name: "isolated_boot", failure: "failed" });
      expect(driver.forbiddenRequests()).toBe(1);
      expect(service.received.at(-1)).toBe("GET /api/version");
      expect(service.received).not.toContain("GET /redirected");
    } finally {
      await service.close();
    }
  }, 180_000);
});
