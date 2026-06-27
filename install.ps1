# Local Agent X — Windows PowerShell installer (thin wrapper).
# GUI installer is the preferred path — see Install Local Agent X Windows
# Installer.exe at the repo root. This wrapper exists for CLI users.
#
# Bootstrap is minimal: ensure Node is present (chicken-and-egg — since
# install-common.mjs needs Node to run), then hand off. All other install
# steps (VS Build Tools, Python, Ollama, npm install, model pull, build,
# shortcuts) now live in scripts/install-common.mjs so a single source of
# truth covers both CLI and GUI flows.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Pinned PortableGit release — keep in sync with installer/Services/GitBootstrap.cs
# (GIT_PORTABLE_VERSION / GIT_PORTABLE_SHA256) and install.bat. The release TAG is
# v$ver.windows.1 but the asset/version string is just $ver.
$GIT_PORTABLE_VERSION = "2.54.0"
$GIT_PORTABLE_SHA256  = "bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311"

# A real Git-for-Windows bash, validated to exist and never the WSL launcher
# (System32\bash.exe / WindowsApps stub). Mirrors src/tools/shell-env.ts
# findGitBash + GitBootstrap.FindExistingBash.
function Find-GitBash {
  $cands = @("$env:LOCALAPPDATA\LocalAgentX\PortableGit\bin\bash.exe")
  $g = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($g) { $root = Split-Path (Split-Path $g.Source); $cands += "$root\bin\bash.exe"; $cands += "$root\usr\bin\bash.exe" }
  $cands += "$env:ProgramFiles\Git\bin\bash.exe"
  $cands += "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
  foreach ($c in $cands) {
    if ($c -and (Test-Path $c) -and ($c -notmatch '\\System32\\') -and ($c -notmatch '\\WindowsApps\\')) { return $c }
  }
  return $null
}

# Guarantee a POSIX shell (Git Bash + MSYS2 coreutils) — the runtime assumes one
# exists. winget first, then the pinned PortableGit self-extractor (checksum
# verified, fail-closed). Runs BEFORE install-common.mjs's posix-shell check.
if (-not (Find-GitBash)) {
  Write-Host "[install] Installing Git for Windows (POSIX shell)…"
  if (Has winget) {
    winget install Git.Git --accept-package-agreements --accept-source-agreements --silent
    $env:PATH = "$env:ProgramFiles\Git\cmd;$env:ProgramFiles\Git\bin;$env:PATH"
  }
  if (-not (Find-GitBash)) {
    Write-Host "[install] winget didn't deliver Git — downloading PortableGit…"
    $ver = $GIT_PORTABLE_VERSION
    $asset = "PortableGit-$ver-64-bit.7z.exe"
    $url = "https://github.com/git-for-windows/git/releases/download/v$ver.windows.1/$asset"
    $root = "$env:LOCALAPPDATA\LocalAgentX"
    $dir = "$root\PortableGit"
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    # The SFX extracts to <its-own-dir>\PortableGit (it ignores -o + the working
    # dir), so it MUST sit in $root for the output to land at $dir. Download it
    # there, not to %TEMP%.
    $sfx = "$root\$asset"
    Invoke-WebRequest -Uri $url -OutFile $sfx -UseBasicParsing
    # Fail-closed checksum: the constant is the source of truth (git-for-windows
    # publishes no SHASUMS file), so a mismatch aborts rather than extracting.
    $hash = (Get-FileHash -Path $sfx -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $GIT_PORTABLE_SHA256) {
      Remove-Item $sfx -Force -ErrorAction SilentlyContinue
      throw "PortableGit checksum mismatch (got $hash, want $GIT_PORTABLE_SHA256) — refusing to extract."
    }
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    # 7-Zip SFX (NOT a zip): -y assume-yes, -gm2 GUI hidden, -nr no auto-run.
    # Start-Process -Wait so we block until extraction finishes (the SFX is a
    # GUI-subsystem exe — `& $sfx` would return before it's done).
    Start-Process -FilePath $sfx -ArgumentList '-y','-gm2','-nr' -Wait -NoNewWindow
    Remove-Item $sfx -ErrorAction SilentlyContinue
    # Prepend bin (bash + coreutils) and cmd (git) to this run's PATH and the
    # persisted user PATH so the shell survives a reboot.
    $env:PATH = "$dir\bin;$dir\cmd;$env:PATH"
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    foreach ($d in @("$dir\cmd", "$dir\bin")) {
      if ($userPath -notlike "*$d*") { $userPath = "$d;$userPath" }
    }
    [Environment]::SetEnvironmentVariable("PATH", $userPath, "User")
  }
}

# Node 22+ (OS-specific bootstrap — must run BEFORE install-common.mjs).
$nodeOk = (Has node) -and ([int]((& node -v).TrimStart('v').Split('.')[0]) -ge 22)
if (-not $nodeOk) {
  Write-Host "[install] Installing Node 24 (LTS)…"
  if (Has winget) {
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -h
    $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH"
  } else {
    # No winget: unpack the portable Node zip to a per-user dir. No admin and
    # no msiexec — the MSI path needed elevation this script doesn't request.
    $ver = "24.16.0"
    # Match the host CPU — win-x64 node.exe won't run natively on Windows on ARM.
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
    $pkg = "node-v$ver-$arch"
    $zip = "$env:TEMP\$pkg.zip"
    $root = "$env:LOCALAPPDATA\LocalAgentX"
    $nodeDir = "$root\$pkg"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$ver/$pkg.zip" -OutFile $zip -UseBasicParsing
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Expand-Archive -Path $zip -DestinationPath $root -Force
    Remove-Item $zip -ErrorAction SilentlyContinue
    $env:PATH = "$nodeDir;$env:PATH"
    # Prepend (not append) to the persisted user PATH so this node wins over any
    # older system node at runtime — otherwise the desktop node-floor gate trips.
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$nodeDir*") {
      [Environment]::SetEnvironmentVariable("PATH", "$nodeDir;$userPath", "User")
    }
  }
}

& node scripts/install-common.mjs @args
