// A wire failure reaches the model with its reason: Node's fetch reports
// "fetch failed" and keeps ECONNRESET/ETIMEDOUT/the TLS error on `cause`.
import { describe, expect, it } from "vitest";
import { failureDetail } from "./http-request.js";

describe("failureDetail", () => {
  it("appends the cause's code, or its message when it has no code", () => {
    expect(failureDetail(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET", message: "read ECONNRESET" } }))).toBe("fetch failed (ECONNRESET)");
    expect(failureDetail(Object.assign(new Error("fetch failed"), { cause: { message: "unable to verify the first certificate" } }))).toBe("fetch failed (unable to verify the first certificate)");
  });

  it("leaves a message that already says why, and one with no cause, as it is", () => {
    expect(failureDetail(Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { cause: { code: "ETIMEDOUT" } }))).toBe("connect ETIMEDOUT 1.2.3.4:443");
    expect(failureDetail(new Error("The operation was aborted"))).toBe("The operation was aborted");
    expect(failureDetail("boom")).toBe("boom");
  });
});
