/**
 * What is still running from inside a worktree's folder once the worktree is
 * done, and the delete that ends it first.
 *
 * Windows will not delete a folder that is a running program's current
 * directory, however long the delete is retried. A worker that backgrounds a
 * program from its worktree (`emulator … &`, `npx expo start &`, a dev server)
 * leaves it running there after the worker is gone, and the folder stays for
 * good: on 2026-11-26 an Android emulator a worker started two days earlier
 * and three dev-server trees held two worktree folders through every restart,
 * each boot logging "could not be deleted: EBUSY". Nothing else finds these:
 * the shell that started them has exited, so no parent chain leads to them.
 *
 * So the question is asked of the folder: which programs have it as their
 * current directory. One of them is a leftover when the program that started
 * it is gone, or is this server. A terminal the owner opened in the folder was
 * started by a program that is still running (the terminal app, Explorer) and
 * is left alone, with the folder.
 *
 * Elsewhere a current directory does not hold a folder, and the delete goes
 * through; nothing is looked for.
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";

import { removeTreeRetrying } from "../util/remove-tree.js";

export interface FolderProcess { pid: number; name: string }
export interface LeftoverSweep {
  /** Ended: left behind by something that has exited, or started by this server. */
  ended: FolderProcess[];
  /** Left running: started by a program that is still running and is not this server. */
  kept: FolderProcess[];
}

// Reads a process's current directory from its own parameter block; Windows
// has no call that returns it for another process. 64-bit processes of this
// user only: anything else reads as unknown and is never touched.
const CWD_READER = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LaxFolderProcesses {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr Reserved1; public IntPtr Peb; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr Pid; public IntPtr Reserved3; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref Basic info, int length, out int returned);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  static IntPtr Pointer(IntPtr handle, IntPtr at) {
    var bytes = new byte[8]; IntPtr read;
    return ReadProcessMemory(handle, at, bytes, (IntPtr)8, out read) ? (IntPtr)BitConverter.ToInt64(bytes, 0) : IntPtr.Zero;
  }
  public static string CurrentDirectory(int pid) {
    IntPtr handle = OpenProcess(0x0410, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      var info = new Basic(); int returned; IntPtr read;
      if (NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(typeof(Basic)), out returned) != 0 || info.Peb == IntPtr.Zero) return null;
      IntPtr parameters = Pointer(handle, IntPtr.Add(info.Peb, 0x20));
      if (parameters == IntPtr.Zero) return null;
      var path = new byte[16];
      if (!ReadProcessMemory(handle, IntPtr.Add(parameters, 0x38), path, (IntPtr)16, out read)) return null;
      int length = BitConverter.ToUInt16(path, 0);
      IntPtr text = (IntPtr)BitConverter.ToInt64(path, 8);
      if (length <= 0 || text == IntPtr.Zero) return null;
      var chars = new byte[length];
      return ReadProcessMemory(handle, text, chars, (IntPtr)length, out read) ? Encoding.Unicode.GetString(chars) : null;
    } catch { return null; } finally { CloseHandle(handle); }
  }
}`;

// The folder, the server's pid and the reader's source reach PowerShell through
// the environment, never the script text (os-trash.ts says why). A parent
// counts only when it was created before its child: a pid reused since the
// real parent exited is not the parent.
const SWEEP = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition $env:LAX_LEFTOVER_READER",
  "$root = $env:LAX_LEFTOVER_DIR.TrimEnd('\\').ToLowerInvariant()",
  "$server = [uint32]$env:LAX_LEFTOVER_SERVER",
  "$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)",
  "$byId = @{}; foreach ($p in $all) { $byId[[uint32]$p.ProcessId] = $p }",
  "function ParentOf($p) { $q = $byId[[uint32]$p.ParentProcessId]; if ($q -and $q.ProcessId -ne $p.ProcessId -and $q.CreationDate -le $p.CreationDate) { $q } }",
  "$inside = @{}",
  "foreach ($p in $all) { if ($p.ProcessId -eq $PID -or $p.ProcessId -eq $server) { continue }",
  "  $cwd = [LaxFolderProcesses]::CurrentDirectory([int]$p.ProcessId); if (-not $cwd) { continue }",
  "  $cwd = $cwd.TrimEnd('\\').ToLowerInvariant()",
  "  if ($cwd -eq $root -or $cwd.StartsWith($root + '\\')) { $inside[[uint32]$p.ProcessId] = $p } }",
  "$end = @{}; $kept = @()",
  "foreach ($p in $inside.Values) { $top = $p; $ours = $false",
  "  for ($i = 0; $i -lt 64; $i++) { $q = ParentOf $top; if (-not $q) { break }; if ($q.ProcessId -eq $server) { $ours = $true; break }; $top = $q }",
  "  if ($ours -or $inside.ContainsKey([uint32]$top.ProcessId)) { $end[[uint32]$p.ProcessId] = $p } else { $kept += $p } }",
  // What a leftover started goes with it, wherever it has since moved to.
  "do { $grew = $false; foreach ($p in $all) { if ($end.ContainsKey([uint32]$p.ProcessId) -or $p.ProcessId -eq $PID -or $p.ProcessId -eq $server) { continue }",
  "  $q = ParentOf $p; if ($q -and $end.ContainsKey([uint32]$q.ProcessId)) { $end[[uint32]$p.ProcessId] = $p; $grew = $true } } } while ($grew)",
  "foreach ($p in $kept) { if (-not $end.ContainsKey([uint32]$p.ProcessId)) { 'kept ' + $p.ProcessId + ' ' + $p.Name } }",
  "foreach ($p in $end.Values) { 'ended ' + $p.ProcessId + ' ' + $p.Name }",
  "if ($end.Count) { $ids = @($end.Keys | ForEach-Object { [int]$_ })",
  "  Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue",
  "  Wait-Process -Id $ids -Timeout 5 -ErrorAction SilentlyContinue }",
  // A wait on a process already gone leaves the last command failed, which
  // PowerShell would report as the script's own failure.
  "exit 0",
].join("\n");

/**
 * End the programs left running from inside `dir` (see the header for which
 * count), and say which were ended and which were left. `serverPid` is the
 * process whose own children count as left behind. Never throws: what could
 * not be looked at is reported as nothing found.
 */
export function endLeftoverProcessesIn(dir: string, serverPid = process.pid): Promise<LeftoverSweep> {
  const none: LeftoverSweep = { ended: [], kept: [] };
  if (process.platform !== "win32") return Promise.resolve(none);
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((done) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", SWEEP], {
      // Run from outside the folder, so the sweep itself holds nothing in it.
      cwd: tmpdir(), windowsHide: true, timeout: 30_000, encoding: "utf-8",
      env: { ...process.env, LAX_LEFTOVER_DIR: resolve(dir), LAX_LEFTOVER_SERVER: String(serverPid), LAX_LEFTOVER_READER: CWD_READER },
    }, (error, stdout) => {
      if (error) { done(none); return; }
      const sweep: LeftoverSweep = { ended: [], kept: [] };
      for (const line of stdout.split(/\r?\n/)) {
        const [verdict, pid, ...name] = line.trim().split(" ");
        if ((verdict === "ended" || verdict === "kept") && Number(pid) > 0) sweep[verdict].push({ pid: Number(pid), name: name.join(" ") });
      }
      done(sweep);
    });
  });
}

const named = (list: FolderProcess[]): string => list.map((p) => `${p.name} (pid ${p.pid})`).join(", ");

/**
 * Delete the folder a removed worktree left behind. When the first try fails,
 * what is still running from inside it is ended and the delete is tried again
 * as the handles close. Never throws; returns whether the folder is gone, and
 * says why through `onGiveUp` when it is not, naming a program that was left
 * running there.
 */
export async function removeWorktreeFolder(
  path: string,
  onGiveUp: (reason: string) => void,
  note: (line: string) => void = () => {},
): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch { /* held: see who by */ }
  const sweep = await endLeftoverProcessesIn(path);
  if (sweep.ended.length) note(`ended what was still running from ${path}: ${named(sweep.ended)}`);
  return removeTreeRetrying(path, (reason) => onGiveUp(sweep.kept.length ? `${reason}; in use by ${named(sweep.kept)}, which this app did not start` : reason));
}
