// The desktop's werift peers leave UDP TURN out when the relay also offers TCP
// or TLS: werift writes the offer only after every TURN allocation settles, and
// an unanswered UDP allocation takes 6.4 s to give up (one phone connect in
// three on 2026-11-19). The list is the broker's Cloudflare shape.
import { describe, it, expect } from "vitest";
import { weriftIceServers } from "./ice-servers.js";

const creds = { username: "u", credential: "c" };
const cloudflare = [
  { urls: "stun:stun.cloudflare.com:3478" },
  {
    urls: [
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
    ],
    ...creds,
  },
];

describe("weriftIceServers", () => {
  it("drops UDP TURN when TURN over TCP and TLS is offered, keeping STUN and the credentials", () => {
    expect(weriftIceServers(cloudflare)).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "turn:turn.cloudflare.com:3478?transport=tcp", ...creds },
      { urls: "turns:turn.cloudflare.com:5349?transport=tcp", ...creds },
    ]);
  });

  it("treats a turn: url without a transport as UDP", () => {
    const urls = weriftIceServers([{ urls: ["turn:h:3478", "turns:h:5349"], ...creds }]).map((s) => s.urls);
    expect(urls).toEqual(["turns:h:5349"]);
  });

  it("keeps UDP TURN when it is the only relay offered", () => {
    const only = [{ urls: "stun:h:3478" }, { urls: "turn:h:3478?transport=udp", ...creds }];
    expect(weriftIceServers(only).map((s) => s.urls)).toEqual(["stun:h:3478", "turn:h:3478?transport=udp"]);
  });

  it("returns nothing for no servers (the tailnet path)", () => {
    expect(weriftIceServers([])).toEqual([]);
  });
});
