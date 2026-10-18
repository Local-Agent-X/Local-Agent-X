import { describe, expect, it } from "vitest";
import { NON_HTTP_TRANSPORTS, normalizeTransport, transportTools } from "./types.js";

// A non-HTTP transport's tools are the rows that declare it (`transport`), so
// a transport this build knows must have at least one, or the agent context
// replaces the "Base URL:" line with an interface that names nothing.
describe("integration transports", () => {
  it("every known transport is carried by at least one tool", () => {
    for (const transport of NON_HTTP_TRANSPORTS) expect(transportTools(transport).length, transport).toBeGreaterThan(0);
  });

  it("names email's whole interface, send first", () => {
    expect(transportTools("smtp_imap")).toEqual([
      "email_send", "email_read", "email_search", "email_read_message", "email_folders", "email_delete", "email_mark",
    ]);
    expect(transportTools("http")).toEqual([]);
  });

  it("degrades a transport this build does not know to http, whatever its shape", () => {
    expect(normalizeTransport("smtp_imap")).toBe("smtp_imap");
    for (const value of ["carrier_pigeon", "toString", 42, undefined, null]) expect(normalizeTransport(value)).toBe("http");
  });
});
