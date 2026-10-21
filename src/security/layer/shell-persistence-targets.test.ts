// The mutation walk knew POSIX verbs and `~` only, so a Windows persistence
// write spelled the way Windows spells it — `copy evil.cmd "%APPDATA%\…\Startup\"`,
// `Copy-Item`, `Set-Content`, `$env:APPDATA` — produced no target and no card
// (red team round 2, I-M1). The same walk now reads the Windows and
// PowerShell spellings and expands the shell's environment references.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellMutationTargets } from "./shell-mutation-guard.js";

const APPDATA = "C:\\Users\\u\\AppData\\Roaming";
const STARTUP = `${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`;
const prior = process.env.APPDATA;
beforeEach(() => { process.env.APPDATA = APPDATA; });
afterEach(() => { if (prior === undefined) delete process.env.APPDATA; else process.env.APPDATA = prior; });

const targets = (cmd: string) => shellMutationTargets(cmd).map((t) => `${t.verb} ${t.path}`);

describe("a Windows write names its target", () => {
  it("for copy, move, xcopy and robocopy", () => {
    expect(targets(`copy evil.cmd "${STARTUP}\\evil.cmd"`)).toEqual([`copy ${STARTUP}\\evil.cmd`]);
    expect(targets(`move /Y evil.cmd "${STARTUP}\\evil.cmd"`)).toEqual([`move ${STARTUP}\\evil.cmd`]);
    expect(targets(`xcopy /E src "${STARTUP}"`)).toEqual([`xcopy ${STARTUP}`]);
    expect(targets(`robocopy src "${STARTUP}" /E`)).toEqual([`robocopy ${STARTUP}`]);
  });

  it("for the PowerShell cmdlets, positional or named", () => {
    expect(targets(`Copy-Item evil.cmd "${STARTUP}\\evil.cmd"`)).toEqual([`copy-item ${STARTUP}\\evil.cmd`]);
    expect(targets(`Copy-Item -Path evil.cmd -Destination "${STARTUP}\\evil.cmd"`)).toEqual([`copy-item ${STARTUP}\\evil.cmd`]);
    expect(targets(`Set-Content -Path "${STARTUP}\\evil.cmd" -Value "calc"`)).toEqual([`set-content ${STARTUP}\\evil.cmd`]);
    expect(targets(`"calc" | Out-File "${STARTUP}\\evil.cmd"`)).toEqual([`out-file ${STARTUP}\\evil.cmd`]);
    expect(targets(`Remove-Item "${STARTUP}\\evil.cmd"`)).toEqual([`remove-item ${STARTUP}\\evil.cmd`]);
  });

  it("with %VAR% and $env:VAR expanded to the folder they name", () => {
    expect(targets(`copy evil.cmd "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.cmd"`)).toEqual([`copy ${STARTUP}\\evil.cmd`]);
    expect(targets(`Copy-Item evil.cmd "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.cmd"`)).toEqual([`copy-item ${STARTUP}\\evil.cmd`]);
    expect(targets(`copy evil.cmd "%NO_SUCH_VAR_X%\\evil.cmd"`)).toEqual([]);
  });

  it("and a relative or read-only operand still names nothing", () => {
    expect(targets("copy a.txt b.txt")).toEqual([]);
    expect(targets(`type "${STARTUP}\\x.cmd"`)).toEqual([]);
    expect(targets(`Get-Content "${STARTUP}\\x.cmd"`)).toEqual([]);
  });
});
