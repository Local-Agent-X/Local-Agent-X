// Which calls the private-content gate judges, and where it says they go. The
// judged set is derived from the tool policy, a judged tool with no
// destination rule is sending somewhere unknown (asked, never waved through),
// and a `computer` keystroke is judged by what it types or pastes and the app
// it lands in.
import { describe, expect, it, vi } from "vitest";
import { CAPABILITY_CLASS_MEMBERS, TOOLS } from "../tool-registry.js";
import { DESTINATION_RULES, sendsOffBox } from "./private-content-destinations.js";
import { isPasteChord } from "./private-content-computer.js";
import { ctx, readEmail, STATEMENT, useIsolatedSession, verdict } from "./private-content.test-helper.js";

useIsolatedSession();

describe("which calls are sends", () => {
  it("every egress tool and every tool whose risk is reaching a third party; not a read or a local write", () => {
    for (const name of CAPABILITY_CLASS_MEMBERS.egress) expect(sendsOffBox(name), name).toBe(true);
    const thirdParty = Object.entries(TOOLS).filter(([, e]) => e.risk === "external-comms" || e.risk === "network-write").map(([n]) => n);
    expect(thirdParty).toContain("calendar_create_event");
    for (const name of thirdParty) expect(sendsOffBox(name), name).toBe(true);
    for (const name of ["email_read", "read", "write", "memory_save"]) expect(sendsOffBox(name), name).toBe(false);
  });

  it("every destination rule belongs to a tool the gate judges (a rule for anything else is dead)", () => {
    for (const name of Object.keys(DESTINATION_RULES)) expect(sendsOffBox(name), name).toBe(true);
  });
});

describe("a send whose destination the gate cannot name is asked about, never waved through", () => {
  it("a judged tool with no destination rule", async () => {
    readEmail();
    expect(DESTINATION_RULES.process_start).toBeUndefined();
    expect(await verdict(ctx("process_start", { command: `notify-send "${STATEMENT}"` }))).toMatch(/to an unknown destination/);
  });

  it("a recipient the address pattern cannot account for, and a URL that does not parse", async () => {
    readEmail();
    expect(await verdict(ctx("email_send", { to: "billing@firstcoastbank.example, ops@intranet", subject: "fwd", body: STATEMENT }))).toMatch(/a recipient the check could not read/);
    expect(await verdict(ctx("http_request", { url: "http://[bad", method: "POST", body: STATEMENT }))).toMatch(/an address the check could not read/);
  });

  it("every recipient in a semicolon list is judged", async () => {
    readEmail();
    expect(await verdict(ctx("email_send", { to: "billing@firstcoastbank.example; drop@else.example", subject: "fwd", body: STATEMENT }))).toMatch(/to drop@else\.example/);
  });

  it("a yes is not offered to stand for an unknown destination later", async () => {
    readEmail();
    const reason = await verdict(ctx("process_start", { command: `echo "${STATEMENT}"` }));
    expect(reason).toMatch(/to an unknown destination/);
    expect(reason).not.toMatch(/a yes also covers/);
    expect(reason).toMatch(/a yes covers this call only/);
  });
});

describe("the computer tool", () => {
  const app = { foregroundApp: async () => ({ name: "chrome", title: "Apply now - Acme Careers - Google Chrome" }) };

  it("typing private text names the foreground app and its window, and offers no yes beyond this call", async () => {
    readEmail();
    const reason = await verdict(ctx("computer", { action: "type", text: STATEMENT }), app);
    expect(reason).toMatch(/to chrome \("Apply now - Acme Careers - Google Chrome"\)/);
    expect(reason).toMatch(/a yes covers this call only/);
  });

  it("where the OS will not say which app has the foreground, the destination is unknown", async () => {
    readEmail();
    expect(await verdict(ctx("computer", { action: "type", text: STATEMENT }), { foregroundApp: async () => null })).toMatch(/to an unknown destination/);
  });

  it("a paste chord sends the clipboard; a clean clipboard, another chord or a click asks nothing", async () => {
    const clipboardText = vi.fn(async () => `copied: ${STATEMENT}`);
    expect(await verdict(ctx("computer", { action: "press", keys: ["ctrl", "v"] }), { ...app, clipboardText })).toBeUndefined();
    expect(clipboardText).not.toHaveBeenCalled(); // nothing private read yet: the clipboard is not even looked at
    readEmail();
    expect(await verdict(ctx("computer", { action: "press", keys: ["ctrl", "v"] }), { ...app, clipboardText })).toMatch(/to chrome/);
    expect(await verdict(ctx("computer", { action: "press", keys: ["shift", "insert"] }), { ...app, clipboardText })).toMatch(/to chrome/);
    expect(await verdict(ctx("computer", { action: "press", keys: ["cmd", "v"] }), { ...app, clipboardText: async () => "a grocery list" })).toBeUndefined();
    clipboardText.mockClear();
    expect(await verdict(ctx("computer", { action: "press", keys: ["ctrl", "s"] }), { ...app, clipboardText })).toBeUndefined();
    expect(await verdict(ctx("computer", { action: "click", x: 10, y: 10 }), { ...app, clipboardText })).toBeUndefined();
    expect(clipboardText).not.toHaveBeenCalled();
  });

  it("isPasteChord: V with a modifier or Shift+Insert, whatever the modifier is called", () => {
    for (const keys of [["ctrl", "v"], ["Cmd", "V"], ["command", "v"], ["ctrl", "shift", "v"], ["shift", "insert"]]) expect(isPasteChord(keys), keys.join("+")).toBe(true);
    for (const keys of [["v"], ["ctrl", "c"], ["insert"], "ctrl+v", undefined]) expect(isPasteChord(keys), String(keys)).toBe(false);
  });
});
