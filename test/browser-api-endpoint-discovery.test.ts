// Cross-seam contract for the read_network endpoint-discovery feature
// (browser API-access, step 1). Exercises the REAL desktop-side ring
// (browser-perception.ts) feeding the REAL server-side report formatter
// (bridge-perception.ts) — the two modules the feature spans — with no mocks,
// so the store-time scrub and the surfacing logic are proven together.
//
// The load-bearing invariant: a data endpoint whose identity/secret lives in
// the query string must surface PATH-ONLY. If the scrub (chunk 1) or the
// surfacing (chunk 2) regressed, a token would leak into the agent-facing
// "API/data endpoints observed" section. read_network output is external-wrapped
// downstream, but a secret must never reach that boundary in the first place.
import { describe, expect, it, beforeEach } from "vitest";
import {
  noteRequestStart,
  noteRequestDone,
  readNetworkEntries,
  _resetBrowserPerceptionForTest,
} from "../desktop/src/browser-perception";
import { formatNetworkReport, type BridgeNetworkEntry } from "../src/browser/bridge-perception";

const PART = "persist:lax-profile-work";

// The ring produces NetworkEntry; the wire carries it verbatim to the server as
// BridgeNetworkEntry (structurally identical). Cross the seam the way the bridge
// does — pass the ring snapshot straight into the server formatter.
function reportFromRing(): string {
  const { entries, inFlight } = readNetworkEntries(PART);
  return formatNetworkReport(entries as BridgeNetworkEntry[], inFlight);
}

describe("read_network endpoint discovery — cross-seam contract", () => {
  beforeEach(() => _resetBrowserPerceptionForTest());

  it("surfaces a JSON XHR GET as a replay candidate, PATH-ONLY (query + secret scrubbed end-to-end)", () => {
    noteRequestStart(PART, 1);
    noteRequestDone(PART, {
      id: 1,
      url: "https://api.example/v2/orders?session_token=SUPER_SECRET&page=2",
      method: "GET",
      statusCode: 200,
      resourceType: "xhr",
      contentType: "application/json",
    });

    const report = reportFromRing();
    const section = report.slice(report.indexOf("API/data endpoints observed"));

    // Discovered and offered for replay…
    expect(section).toContain("API/data endpoints observed");
    expect(section).toContain("  GET 200 application/json https://api.example/v2/orders");
    // …but PATH-ONLY: neither the secret nor the query key/params survive to the
    // agent-facing surface anywhere in the whole report.
    expect(report).not.toContain("SUPER_SECRET");
    expect(report).not.toContain("session_token");
    expect(report).not.toContain("page=2");
    // The section discloses its own lossiness so the agent doesn't trust a
    // param-stripped URL blindly.
    expect(section).toContain("PATH-ONLY");
  });

  it("does not fabricate a replay section when the page hit no data endpoints", () => {
    noteRequestStart(PART, 2);
    noteRequestDone(PART, {
      id: 2,
      url: "https://example.com/index.html",
      method: "GET",
      statusCode: 200,
      resourceType: "document",
      contentType: "text/html",
    });
    expect(reportFromRing()).not.toContain("API/data endpoints observed");
  });
});
