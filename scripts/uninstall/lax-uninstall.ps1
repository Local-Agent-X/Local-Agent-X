# Local Agent X - standalone uninstaller (Windows).
#
# This file is BOTH the registered Add/Remove-Programs uninstaller AND the
# rescue script a stuck user can download and run on its own. It is
# deliberately self-contained: no Node, no npm, no repo checkout, no working
# Local Agent X install, and no working update system are required. That is
# the whole point - a user whose install is broken cannot receive a fix
# through the updater, so the escape hatch must not depend on any of it.
#
# It discovers what is installed rather than trusting hardcoded paths, so it
# cleans up every historical install shape:
#   - script install      -> %LOCALAPPDATA%\Local Agent X   (HKCU key LocalAgentX)
#   - packaged install    -> %LOCALAPPDATA%\Programs\local-agent-x-desktop (NSIS GUID key)
#   - hybrid (both)       -> packaged shell + source tree at config.json projectRoot
#
# Usage (interactive):   powershell -ExecutionPolicy Bypass -File lax-uninstall.ps1
# Usage (keep data):     ... -Yes
# Usage (factory reset): ... -Yes -DeleteData
# Usage (preview only):  ... -DryRun

param(
  [switch]$DeleteData,              # also remove ~/.lax (chats, memory, API keys)
  [switch]$Yes,                     # no prompts
  [switch]$DryRun,                  # report what would be removed, remove nothing
  [switch]$SkipVendorUninstaller,   # set by the NSIS hook to avoid re-entering itself
  [switch]$FromTemp                 # internal: we are already running from a temp copy
)

$ErrorActionPreference = 'SilentlyContinue'
$script:Removed = @()
$script:Skipped = @()

# --- Re-launch from TEMP -----------------------------------------------------
# We may be sitting inside a directory we are about to delete. Copy ourselves
# to TEMP and re-exec from there so the removal can never fail on "file in use".
if (-not $FromTemp -and -not $DryRun) {
  $tmp = Join-Path $env:TEMP 'lax-uninstall.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $tmp -Force
  $relaunch = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $tmp + '"'), '-FromTemp')
  if ($DeleteData) { $relaunch += '-DeleteData' }
  if ($Yes) { $relaunch += '-Yes' }
  if ($SkipVendorUninstaller) { $relaunch += '-SkipVendorUninstaller' }
  Start-Process powershell -ArgumentList $relaunch
  return
}

# --- Safety ------------------------------------------------------------------
# A wrong path here deletes someone's source tree, so removal is gated on an
# allowlist of roots plus a hard refusal to touch anything that looks like a
# git checkout. A developer whose projectRoot points at their own clone must
# get their clone back untouched.
$Home_ = $env:USERPROFILE
$SafeRoots = @($env:LOCALAPPDATA, $env:APPDATA, (Join-Path $Home_ '.lax'), (Join-Path $Home_ 'AppData'))

function Test-Removable {
  param([string]$Path)
  if (-not $Path) { return $false }
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $full = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')
  if ($full.Length -lt 8) { $script:Skipped += "$full (path too short to be safe)"; return $false }
  if ($full -eq $Home_.TrimEnd('\')) { $script:Skipped += "$full (is your home folder)"; return $false }
  foreach ($r in @($env:LOCALAPPDATA, $env:APPDATA, $env:ProgramFiles, 'C:\Windows')) {
    if ($r -and $full -eq $r.TrimEnd('\')) { $script:Skipped += "$full (is a system root)"; return $false }
  }
  # Never delete a git checkout. A source tree with .git is someone's working
  # copy, not an install artifact - deleting it destroys uncommitted work.
  if (Test-Path -LiteralPath (Join-Path $full '.git')) {
    $script:Skipped += "$full (git checkout - left alone on purpose)"
    return $false
  }
  return $true
}

function Test-InSafeRoot {
  param([string]$Path)
  $full = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')
  foreach ($r in $SafeRoots) {
    if ($r -and $full.StartsWith($r.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Test-LaxSourceTree {
  param([string]$Path)
  # Sentinels that identify OUR source tree specifically, so a mis-set
  # projectRoot can't turn this into a generic directory shredder.
  if (-not (Test-Path -LiteralPath (Join-Path $Path 'package.json'))) { return $false }
  try {
    $pkg = Get-Content -LiteralPath (Join-Path $Path 'package.json') -Raw | ConvertFrom-Json
    if ($pkg.name -eq 'local-agent-x' -or $pkg.name -eq 'local-agent-x-desktop') { return $true }
  } catch {}
  return (Test-Path -LiteralPath (Join-Path $Path 'src\index.ts')) -and (Test-Path -LiteralPath (Join-Path $Path 'desktop'))
}

function Remove-LaxPath {
  param([string]$Path, [string]$Label, [switch]$AllowOutsideSafeRoot)
  if (-not (Test-Removable $Path)) { return }
  $full = (Resolve-Path -LiteralPath $Path).Path
  if (-not $AllowOutsideSafeRoot -and -not (Test-InSafeRoot $full)) {
    $script:Skipped += "$full (outside expected install roots)"
    return
  }
  if ($DryRun) { $script:Removed += "[dry-run] $Label -> $full"; return }
  Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $full) { $script:Skipped += "$full (removal failed - file in use?)" }
  else { $script:Removed += "$Label -> $full" }
}

# --- Discovery ---------------------------------------------------------------
function Get-LaxRegistryEntries {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $found = @()
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($p.DisplayName -like 'Local Agent X*') {
        $found += [pscustomobject]@{
          KeyPath         = $key.PSPath
          DisplayName     = $p.DisplayName
          DisplayVersion  = $p.DisplayVersion
          InstallLocation = $p.InstallLocation
          UninstallString = $p.UninstallString
        }
      }
    }
  }
  return $found
}

function Get-ProjectRoot {
  $cfg = Join-Path $Home_ '.lax\config.json'
  if (-not (Test-Path -LiteralPath $cfg)) { return $null }
  try { return (Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json).projectRoot } catch { return $null }
}

$entries    = Get-LaxRegistryEntries
$projectRoot = Get-ProjectRoot
$laxDir      = Join-Path $Home_ '.lax'

# Candidate install directories, de-duplicated. Order matters only for reporting.
$dirs = New-Object System.Collections.ArrayList
function Add-Dir { param([string]$p, [string]$label, [bool]$vendor = $false)
  if (-not $p) { return }
  if ($dirs | Where-Object { $_.Path -ieq $p }) { return }
  [void]$dirs.Add([pscustomobject]@{ Path = $p; Label = $label; Vendor = $vendor })
}
Add-Dir (Join-Path $env:LOCALAPPDATA 'Local Agent X') 'source tree (script install)'
Add-Dir (Join-Path $env:LOCALAPPDATA 'Programs\local-agent-x-desktop') 'packaged app (NSIS)' $true
Add-Dir (Join-Path $env:APPDATA 'Local Agent X') 'Electron user data'
Add-Dir (Join-Path $env:APPDATA 'electron') 'Electron user data (legacy)'
# A registered install whose uninstaller is an .exe is owned by that installer.
foreach ($e in $entries) { Add-Dir $e.InstallLocation "registered install ($($e.DisplayName))" ($e.UninstallString -match '\.exe') }
if ($projectRoot -and (Test-LaxSourceTree $projectRoot)) { Add-Dir $projectRoot 'source tree (projectRoot)' }

# When the packaged uninstaller invoked US (its customUnInstall hook), it is
# mid-flight and removing its own directory. Touching vendor-owned paths from
# here would race it - and it does that job correctly on its own. We are here
# for everything it does not know about: the source tree, user data, the stale
# projectRoot pointer and the second registry key.
if ($SkipVendorUninstaller) {
  $vendorOwned = @($dirs | Where-Object { $_.Vendor })
  foreach ($v in $vendorOwned) { [void]$dirs.Remove($v) }
}

$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Local Agent X.lnk'),
  (Join-Path (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs') 'Local Agent X.lnk')
)

# --- Confirm -----------------------------------------------------------------
$plan = @()
foreach ($d in $dirs) { if (Test-Path -LiteralPath $d.Path) { $plan += "  $($d.Label): $($d.Path)" } }
foreach ($e in $entries) { $plan += "  registry: $($e.DisplayName) $($e.DisplayVersion)" }
if ($plan.Count -eq 0) {
  $msg = 'No Local Agent X installation was found on this machine - nothing to remove.'
  if ($Yes -or $DryRun) { Write-Output $msg } else {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($msg, 'Local Agent X', 'OK', 'Information')
  }
  return
}

if (-not $Yes -and -not $DryRun) {
  Add-Type -AssemblyName System.Windows.Forms
  $nl = [Environment]::NewLine
  $body = 'Remove Local Agent X?' + $nl + $nl + ($plan -join $nl) + $nl + $nl +
          'Also delete your data (chats, memory, saved API keys)?' + $nl +
          'Choose No to keep it for a future reinstall.'
  $ans = [System.Windows.Forms.MessageBox]::Show($body, 'Uninstall Local Agent X', 'YesNoCancel', 'Warning')
  if ($ans -eq [System.Windows.Forms.DialogResult]::Cancel) { return }
  if ($ans -eq [System.Windows.Forms.DialogResult]::Yes) { $DeleteData = $true }
} elseif ($DryRun) {
  Write-Output 'Would remove:'
  $plan | ForEach-Object { Write-Output $_ }
  if ($DeleteData) { Write-Output "  data: $laxDir" }
}

# --- Stop running processes --------------------------------------------------
# Electron holds file handles inside the install dir; a live server holds the
# source tree. Kill both before removal or the delete silently half-completes.
if (-not $DryRun) {
  Get-Process -Name 'LocalAgentX', 'Local Agent X', 'electron' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  # Node processes whose command line points into an install dir (the tsx server).
  try {
    $targets = @($dirs | ForEach-Object { $_.Path })
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
      $cl = $_.CommandLine
      if (-not $cl) { return }
      foreach ($t in $targets) {
        if ($t -and $cl -like "*$t*") { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; break }
      }
    }
  } catch {}
  Start-Sleep -Seconds 2
}

# --- Run the packaged (NSIS) uninstaller first -------------------------------
# It owns its own registry key and Programs directory. Let it do its own job,
# then we clean up everything it does not know about. Skipped when we were
# invoked BY that uninstaller, otherwise the two would call each other forever.
if (-not $SkipVendorUninstaller -and -not $DryRun -and $env:LAX_UNINSTALL_ACTIVE -ne '1') {
  $env:LAX_UNINSTALL_ACTIVE = '1'
  foreach ($e in $entries) {
    if ($e.UninstallString -match '\.exe') {
      $exe = ($e.UninstallString -replace '^"([^"]+)".*$', '$1') -replace '^([^\s]+\.exe).*$', '$1'
      if (Test-Path -LiteralPath $exe) {
        $script:Removed += "ran packaged uninstaller -> $exe"
        Start-Process -FilePath $exe -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue
      }
    }
  }
}

# --- Remove ------------------------------------------------------------------
foreach ($d in $dirs) {
  # A registered InstallLocation can legitimately live outside the standard
  # roots (a user chose their own folder), so those are allowed through the
  # safe-root gate - the .git and sentinel checks still apply.
  $outside = ($d.Label -like 'registered install*') -or ($d.Label -eq 'source tree (projectRoot)')
  if ($outside) { Remove-LaxPath -Path $d.Path -Label $d.Label -AllowOutsideSafeRoot }
  else { Remove-LaxPath -Path $d.Path -Label $d.Label }
}

foreach ($lnk in $shortcuts) {
  if (Test-Path -LiteralPath $lnk) {
    if ($DryRun) { $script:Removed += "[dry-run] shortcut -> $lnk" }
    else { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue; $script:Removed += "shortcut -> $lnk" }
  }
}

if ($DeleteData) {
  Remove-LaxPath -Path $laxDir -Label 'data directory' -AllowOutsideSafeRoot
} elseif (Test-Path -LiteralPath $laxDir) {
  # Drop only the stale pointer, so a reinstall cannot resurrect a dead
  # projectRoot while every chat, memory and key is preserved.
  if (-not $DryRun) {
    $cfg = Join-Path $laxDir 'config.json'
    if (Test-Path -LiteralPath $cfg) {
      try {
        $j = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json
        $j.PSObject.Properties.Remove('projectRoot')
        ($j | ConvertTo-Json -Depth 40) | Set-Content -LiteralPath $cfg -Encoding utf8
        $script:Removed += 'cleared stale projectRoot from ~/.lax/config.json'
      } catch {}
    }
  }
}

# Registry entries last: if anything above failed we still want the entry gone,
# because a key pointing at a half-removed install is exactly the state that
# leaves users with an Add/Remove row that does nothing.
if (-not $DryRun) {
  foreach ($e in Get-LaxRegistryEntries) {
    Remove-Item -LiteralPath $e.KeyPath -Recurse -Force -ErrorAction SilentlyContinue
    $script:Removed += "registry -> $($e.DisplayName)"
  }
}

# --- Report ------------------------------------------------------------------
$nl = [Environment]::NewLine
$summary = 'Local Agent X has been removed.'
if ($DeleteData) { $summary += $nl + 'Your data was deleted.' }
else { $summary += $nl + 'Your data was kept in ' + $laxDir + ' for a future reinstall.' }
if ($script:Skipped.Count -gt 0) { $summary += $nl + $nl + 'Left alone:' + $nl + ($script:Skipped -join $nl) }
$summary += $nl + $nl + '(Ollama and any downloaded models were left installed.)'

if ($Yes -or $DryRun) {
  Write-Output $summary
  $script:Removed | ForEach-Object { Write-Output "  removed: $_" }
} else {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($summary, 'Uninstall complete', 'OK', 'Information')
}
