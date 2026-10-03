// Every spelling of this server's own address carries the agent token. The
// egress gate admits every loopback alias on the self port and the pinning
// dispatcher dials each one to the loopback literal, so a self-call written as
// `[::1]` or `localhost.localdomain` reaches the same server — and used to
// arrive unauthenticated, because the header matched only three spellings and
// `::1` never matched at all (URL.hostname keeps the brackets).

import { describe, it, expect, beforeAll } from "vitest";
import { setInternalAgentToken } from "../rbac.js";
import { getRuntimeConfig } from "../config.js";
import { selfCallAuthHeader, reachesOwnServer } from "./web-egress.js";

const INTERNAL = "internal-agent-token-selfcall-aliases";

describe("selfCallAuthHeader recognizes every loopback alias of the self port", () => {
  let port: number;
  beforeAll(() => {
    port = getRuntimeConfig().port;
    setInternalAgentToken(INTERNAL);
  });

  const SELF = (p: number) => [
    `http://127.0.0.1:${p}/api/settings`,
    `http://localhost:${p}/api/settings`,
    `http://LOCALHOST:${p}/api/settings`,
    `http://[::1]:${p}/api/settings`,
    `http://localhost.localdomain:${p}/api/settings`,
    `http://ip6-localhost:${p}/api/settings`,
    `http://ip6-loopback:${p}/api/settings`,
  ];

  it("each alias on the self port gets the agent token", async () => {
    for (const url of SELF(port)) {
      expect(await reachesOwnServer(url), url).toBe(true);
      expect(await selfCallAuthHeader(url), url).toEqual({ Authorization: `Bearer ${INTERNAL}` });
    }
  });

  it("another port, another 127/8 address, or another host gets nothing", async () => {
    for (const url of [
      `http://[::1]:${port + 1}/api/settings`,
      `http://localhost.localdomain:${port + 1}/`,
      `http://127.0.0.2:${port}/api/settings`,
      `http://localhost.evil.example:${port}/`,
      `https://evil.example.com:${port}/`,
      "not a url",
    ]) {
      expect(await reachesOwnServer(url), url).toBe(false);
      expect(await selfCallAuthHeader(url), url).toBeNull();
    }
  });
});
