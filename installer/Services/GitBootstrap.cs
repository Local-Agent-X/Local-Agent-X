using System.Security.Cryptography;

namespace LocalAgentX.Installer.Services;

// Git bootstrap — runs BEFORE NodeBootstrap in the install flow so a real
// POSIX shell (Git-for-Windows bash + the MSYS2 coreutils userland) is a
// guaranteed dependency. The runtime (src/tools/shell-env.ts resolveWindowsShell)
// then assumes bash exists instead of silently degrading to PowerShell.
//
// PortableGit, not MinGit: the agent leans on grep/head/sed/awk/heredocs, not
// just git plumbing. MinGit ships git without bash/coreutils — a new failure
// class. PortableGit ships the full userland.
//
// PortableGit is a 7-Zip SFX (.7z.exe), NOT a .zip — ZipFile.ExtractToDirectory
// (NodeBootstrap's path) cannot unpack it. We run the self-extractor silently.
// Windows-only; mirrors install.ps1 / install.bat for the CLI flow.
public class GitBootstrap
{
    public event Action<string>? OnStatus;   // human-readable status line
    public event Action<string>? OnLogLine;  // raw download/extract output

    // Pinned PortableGit release. Keep in sync with install.ps1 / install.bat
    // (GIT_PORTABLE_VERSION there). The release TAG is v{VER}.windows.1 but the
    // asset/version string is just {VER} — see BuildDownloadUrl.
    public const string GIT_PORTABLE_VERSION = "2.54.0";

    // SHA256 of PortableGit-2.54.0-64-bit.7z.exe, hard-pinned and verified
    // fail-closed. git-for-windows does NOT publish a nodejs.org-style
    // SHASUMS256.txt, so there's nothing to trust-on-fetch: the constant IS the
    // source of truth. Cross-checked against the GitHub releases API asset
    // `digest` field and the Fossies archive checksum listing (they agree).
    // Re-pin when bumping the version (gh api …/releases/latest → asset.digest).
    public const string GIT_PORTABLE_SHA256 =
        "bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311";

    // ── Pure builders (no network / no clean OS needed → unit-testable) ──

    public static string AssetFileName(string version) => $"PortableGit-{version}-64-bit.7z.exe";

    // Tag = v{VER}.windows.1, filename = PortableGit-{VER}-64-bit.7z.exe.
    public static string BuildDownloadUrl(string version) =>
        $"https://github.com/git-for-windows/git/releases/download/v{version}.windows.1/{AssetFileName(version)}";

    // LOAD-BEARING COUPLING: this path MUST stay byte-identical to
    // portableGitBashPath() in src/tools/shell-env.ts
    // (…\LocalAgentX\PortableGit, with bin\bash.exe under it). The installer
    // writes PortableGit here; the runtime resolver reads it. Change one,
    // change both, or the resolver won't find what the installer wrote.
    public static string ExtractDir() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "LocalAgentX", "PortableGit");

    // 7-Zip SFX silent-extract args. -y assume-yes, -gm2 GUI fully hidden, -nr
    // don't auto-run git-bash after extract.
    //
    // IMPORTANT (empirically confirmed against PortableGit 2.54.0): the
    // PortableGit SFX IGNORES -o AND the working directory — it always extracts
    // to <directory-of-the-.exe>\PortableGit. So the destination is chosen by
    // WHERE the .exe sits, not by an argument; InstallGitFromSfx places it in
    // ExtractDir's parent so the output lands exactly at ExtractDir.
    public static string[] BuildSfxArgs() => new[] { "-y", "-gm2", "-nr" };

    // LAX_FORCE_GIT_BOOTSTRAP=1 skips the "already present" short-circuit so the
    // real download/extract path can be exercised on a dev box that has Git.
    static bool ForceBootstrap() =>
        Environment.GetEnvironmentVariable("LAX_FORCE_GIT_BOOTSTRAP") is "1" or "true";

    // True when a usable POSIX bash is already present (and we may skip
    // provisioning). The force hook flips this off for testing.
    public bool GitAvailable() => !ForceBootstrap() && FindExistingBash() != null;

    // Returns true on success, false if provisioning failed. The caller
    // re-verifies via FindExistingBash() — that is the single source of truth.
    public bool InstallGit()
    {
        if (!OperatingSystem.IsWindows()) return true; // macOS/Linux ship a real bash.
        OnStatus?.Invoke("Installing Git for Windows (POSIX shell)…");

        // winget first (parity with Node + install.ps1). Its exit code is
        // unreliable, so don't gate on it — splice the standard Git dirs into
        // this run's PATH, then verify the real goal: a non-WSL bash.exe exists.
        InstallerShell.RunStreaming("winget", new[] {
            "install", "Git.Git",
            "--accept-package-agreements", "--accept-source-agreements",
            "--silent", "--disable-interactivity",
        }, OnLogLine);
        SpliceWingetGitDirs();
        if (FindExistingBash() != null) return true;

        OnStatus?.Invoke("winget didn't deliver Git — downloading PortableGit…");
        InstallGitFromSfx();
        return FindExistingBash() != null;
    }

    // Fallback when winget can't deliver Git: download the pinned PortableGit
    // self-extractor, checksum-verify it (fail-closed), and run it silently to
    // unpack into %LOCALAPPDATA%\LocalAgentX\PortableGit. No admin, no winget.
    bool InstallGitFromSfx()
    {
        var extractDir = ExtractDir();
        // The SFX extracts to <its-own-dir>\PortableGit (it ignores -o + cwd), so
        // it MUST sit in ExtractDir's parent for the output to land at ExtractDir.
        // The folder name "PortableGit" is baked into the SFX — ExtractDir's leaf
        // is "PortableGit" to match. Hence download here, NOT to %TEMP%.
        var parent = Directory.GetParent(extractDir)!.FullName;
        Directory.CreateDirectory(parent);
        var sfx = Path.Combine(parent, AssetFileName(GIT_PORTABLE_VERSION));
        try
        {
            var url = BuildDownloadUrl(GIT_PORTABLE_VERSION);
            OnLogLine?.Invoke($"Downloading {url}");
            using (var http = new HttpClient())
            {
                // ~56 MB — give it room beyond the default 100s HttpClient timeout.
                http.Timeout = TimeSpan.FromMinutes(15);
                http.DefaultRequestHeaders.UserAgent.ParseAdd("LocalAgentXInstaller/1.0");
                File.WriteAllBytes(sfx, http.GetByteArrayAsync(url).GetAwaiter().GetResult());
            }

            OnStatus?.Invoke("Verifying the Git download…");
            if (!VerifyChecksum(sfx, GIT_PORTABLE_SHA256))
            {
                OnLogLine?.Invoke("[error] PortableGit checksum mismatch — refusing to extract.");
                return false;
            }

            OnStatus?.Invoke("Unpacking the POSIX shell (Git Bash)…");
            if (Directory.Exists(extractDir)) Directory.Delete(extractDir, true);
            // SFX, not a zip — run it. Process.Start/WaitForExit waits for the
            // extractor to finish; it writes <parent>\PortableGit == extractDir.
            if (!InstallerShell.RunStreaming(sfx, BuildSfxArgs(), OnLogLine))
            {
                OnLogLine?.Invoke("[error] PortableGit self-extractor returned non-zero.");
                return false;
            }
            if (FindExistingBash() is null)
            {
                OnLogLine?.Invoke("[error] PortableGit extracted but no bash.exe was produced.");
                return false;
            }

            // Portable runtime: findable now (this process) and at reboot
            // (persisted user PATH). Both bin (bash + coreutils) and cmd (git).
            foreach (var sub in new[] { "bin", "cmd" })
            {
                InstallerShell.SplicePath(Path.Combine(extractDir, sub));
                InstallerShell.PersistUserPath(Path.Combine(extractDir, sub));
            }
            return true;
        }
        catch (Exception ex)
        {
            OnLogLine?.Invoke($"[error] PortableGit provision failed: {ex.Message}");
            return false;
        }
        finally
        {
            try { File.Delete(sfx); } catch { }
        }
    }

    // Fail-closed SHA256 check against the hard-pinned constant.
    static bool VerifyChecksum(string file, string expectedSha256)
    {
        using var fs = File.OpenRead(file);
        var hex = Convert.ToHexString(SHA256.HashData(fs)).ToLowerInvariant();
        return string.Equals(hex, expectedSha256, StringComparison.OrdinalIgnoreCase);
    }

    // winget's Git.Git lands in Program Files\Git (machine) or
    // %LOCALAPPDATA%\Programs\Git (per-user). SplicePath no-ops on absent dirs,
    // so splice every candidate's bin+cmd and let the verify decide.
    static void SpliceWingetGitDirs()
    {
        var pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files";
        var local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        foreach (var root in new[] { Path.Combine(pf, "Git"), local is null ? null : Path.Combine(local, "Programs", "Git") })
        {
            if (root is null) continue;
            InstallerShell.SplicePath(Path.Combine(root, "bin"));
            InstallerShell.SplicePath(Path.Combine(root, "cmd"));
        }
    }

    // A real Git-for-Windows bash, existence-validated and never the WSL
    // launcher. Mirrors src/tools/shell-env.ts findGitBash so the installer's
    // "already present" check and the runtime resolver agree on what counts.
    public static string? FindExistingBash()
    {
        var candidates = new List<string>
        {
            // Our own portable extract dir (a previous run, or one just written).
            Path.Combine(ExtractDir(), "bin", "bash.exe"),
            Path.Combine(ExtractDir(), "usr", "bin", "bash.exe"),
        };
        var gitExe = FindOnPath("git.exe");
        if (gitExe != null && !IsWslLauncher(gitExe))
        {
            // <Git>\cmd\git.exe or <Git>\bin\git.exe → <Git>
            var root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(gitExe)!, ".."));
            candidates.Add(Path.Combine(root, "bin", "bash.exe"));
            candidates.Add(Path.Combine(root, "usr", "bin", "bash.exe"));
        }
        var pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files";
        var pfx86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? @"C:\Program Files (x86)";
        var local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        candidates.Add(Path.Combine(pf, "Git", "bin", "bash.exe"));
        candidates.Add(Path.Combine(pf, "Git", "usr", "bin", "bash.exe"));
        candidates.Add(Path.Combine(pfx86, "Git", "bin", "bash.exe"));
        if (local != null) candidates.Add(Path.Combine(local, "Programs", "Git", "bin", "bash.exe"));

        foreach (var c in candidates)
            if (!IsWslLauncher(c) && File.Exists(c)) return c;
        return null;
    }

    static string? FindOnPath(string exe)
    {
        foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (string.IsNullOrEmpty(d)) continue;
            try { var c = Path.Combine(d, exe); if (File.Exists(c)) return c; } catch { }
        }
        return null;
    }

    // System32\bash.exe + WindowsApps stubs are the WSL entrypoint — they throw
    // "execvpe(/bin/bash) failed" with no distro, so they are never a POSIX shell.
    static bool IsWslLauncher(string p)
    {
        var low = p.ToLowerInvariant().Replace('/', '\\');
        return low.Contains(@"\system32\") || low.Contains(@"\windowsapps\");
    }
}
