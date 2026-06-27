using LocalAgentX.Installer.Services;

namespace LocalAgentX.Installer.Tests;

// Pure-helper tests for GitBootstrap — the URL/asset/extract-path/SFX-arg
// builders. They take no network and no clean OS, so they pin the trap-door
// details (the tag-vs-version mismatch, the SFX's exe-dir extract behavior)
// that are easy to get subtly wrong.
public class GitBootstrapTests
{
    [Fact]
    public void AssetFileName_matches_the_published_asset_format()
    {
        Assert.Equal("PortableGit-2.54.0-64-bit.7z.exe", GitBootstrap.AssetFileName("2.54.0"));
    }

    [Fact]
    public void BuildDownloadUrl_uses_vVERSION_windows_1_tag_but_bare_version_asset()
    {
        // The trap: the release TAG is v{VER}.windows.1 while the asset/version
        // string is just {VER}. Getting either wrong yields a 404.
        Assert.Equal(
            "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/PortableGit-2.54.0-64-bit.7z.exe",
            GitBootstrap.BuildDownloadUrl("2.54.0"));
    }

    [Fact]
    public void BuildDownloadUrl_uses_the_pinned_version_constant()
    {
        Assert.Contains($"v{GitBootstrap.GIT_PORTABLE_VERSION}.windows.1", GitBootstrap.BuildDownloadUrl(GitBootstrap.GIT_PORTABLE_VERSION));
        Assert.EndsWith(GitBootstrap.AssetFileName(GitBootstrap.GIT_PORTABLE_VERSION), GitBootstrap.BuildDownloadUrl(GitBootstrap.GIT_PORTABLE_VERSION));
    }

    [Fact]
    public void ExtractDir_leaf_is_PortableGit_under_LocalAgentX()
    {
        // The SFX bakes the folder name "PortableGit" and extracts to
        // <exe-dir>\PortableGit, so InstallGitFromSfx drops the exe in the
        // PARENT — which means ExtractDir's leaf MUST be "PortableGit" and its
        // parent the LocalAgentX runtime dir. Lock both.
        var dir = GitBootstrap.ExtractDir();
        Assert.Equal("PortableGit", Path.GetFileName(dir));
        Assert.Equal("LocalAgentX", Path.GetFileName(Path.GetDirectoryName(dir)!));
    }

    [Fact]
    public void ExtractDir_stays_in_lockstep_with_the_runtime_resolver_path()
    {
        // LOAD-BEARING COUPLING with src/tools/shell-env.ts portableGitBashPath:
        // …\LocalAgentX\PortableGit\bin\bash.exe. If this changes, change the TS
        // resolver too, or the installer writes bash where the runtime never looks.
        var bash = Path.Combine(GitBootstrap.ExtractDir(), "bin", "bash.exe");
        Assert.EndsWith(Path.Combine("LocalAgentX", "PortableGit", "bin", "bash.exe"), bash);
    }

    [Fact]
    public void BuildSfxArgs_are_silent_and_carry_no_output_flag()
    {
        // -y assume-yes, -gm2 GUI hidden, -nr no auto-run. Crucially NO -o: the
        // PortableGit SFX ignores it (extracts to the exe's own dir instead).
        var args = GitBootstrap.BuildSfxArgs();
        Assert.Equal(new[] { "-y", "-gm2", "-nr" }, args);
        Assert.DoesNotContain(args, a => a.StartsWith("-o"));
    }

    [Fact]
    public void GIT_PORTABLE_SHA256_is_a_lowercase_64_hex_digest()
    {
        Assert.Matches("^[0-9a-f]{64}$", GitBootstrap.GIT_PORTABLE_SHA256);
    }
}
