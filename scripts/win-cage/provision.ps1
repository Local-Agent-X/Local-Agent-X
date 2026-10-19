<#
  Local Agent X - Windows shell network cage provisioning.

  The ONE implementation of "install the cage": the standalone installer runs
  it on a fresh install, the app runs it from Settings (install, update,
  remove), and the app's uninstaller runs it with -Uninstall -RemoveHelper. It needs administrator rights, so when it is not
  elevated it relaunches itself once through UAC and returns that run's exit
  code.

  What it does (elevated):
    1. Verifies the helper's Authenticode signature against the installer's
       own when -SignerLike is given (a developer build's installer is
       unsigned, and then nothing is checked).
    2. Copies the helper to %ProgramData%\Local Agent X\bin, a folder every
       account can read. The sandbox account cannot read anything under a
       user profile, so a helper there fails with "access denied".
    3. Runs the helper's install: the lax-sandbox account, its logon denials,
       and the WFP fence under LAX's own sublayer, permitting loopback only to
       the shell egress proxy's port range. -Force replaces an install whose
       range differs (the app moved its proxy off a range Windows reserved):
       the fence is rewritten in place, the account kept.
    4. Reserves the range in Windows' own port table (an administered
       exclusion; the proxy can still bind it). Hyper-V, WSL2 and Docker take
       blocks of Windows' dynamic port range at boot, and a port in such a
       block cannot be bound: without the reservation a restart could take
       the range, move the proxy off it, and leave the fence permitting a
       range nothing listens on. The reserved range is recorded in
       $reservationFile, so a repair that moves it releases the old one.

  -Uninstall removes the fence, the account and the reservation, and keeps
  the helper, so Settings can install the cage again with no installer.
  -RemoveHelper also deletes the helper: only the app's own uninstaller
  passes it.

  Exit codes: the helper's own (0 installed, 10 UAC cancelled, 12 filters,
  13 different range already installed, 14 user), plus 2 helper missing,
  3 signature rejected (-SignerLike names a signed executable, normally the
  installer, whose publisher the helper must match), 4 no -PortRange, and
  15 installed but the range could not be reserved (the cage works; a later
  restart may need a repair).

  -PortRange has no default: it is the range the app chose for its egress
  proxy (src/net/shell-proxy-ports.ts), and a permit that names any other
  range leaves the cage with no route out.
#>
param(
  [string]$Helper = "",
  [string]$PortRange = "",
  # The helper must be signed by the same publisher as this executable (the
  # installer that carried it). Nothing is checked when that executable is
  # itself unsigned: a developer build.
  [string]$SignerLike = "",
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$RemoveHelper
)

$ErrorActionPreference = "Stop"
# LAX's own sublayer and account, so a machine that also runs Anthropic's
# sandbox-runtime (its default sublayer, its srt-sandbox user) keeps both.
$SublayerGuid = "6f3b9c1e-4a7d-4e52-9c0b-2d8e5f1a7b34"
$SandboxUser = "lax-sandbox"
$binDir = Join-Path $env:ProgramData "Local Agent X\bin"
$installed = Join-Path $binDir "srt-win.exe"
# Outside $binDir, which -RemoveHelper deletes.
$reservationFile = Join-Path $env:ProgramData "Local Agent X\proxy-port-reservation.txt"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# "from-to" as two numbers, or $null.
function Get-PortBounds([string]$Range) {
  if ($Range -match '^\s*(\d+)-(\d+)\s*$') { return @([int]$Matches[1], [int]$Matches[2]) }
  return $null
}

# Whether an administered exclusion (netsh marks them *) covers the range.
function Test-PortsReserved([int]$From, [int]$To) {
  foreach ($line in (netsh interface ipv4 show excludedportrange protocol=tcp)) {
    if ($line -match '^\s*(\d+)\s+(\d+)\s+\*\s*$' -and [int]$Matches[1] -le $From -and [int]$Matches[2] -ge $To) { return $true }
  }
  return $false
}

# Release the reservation this script recorded, if any.
function Remove-PortReservation {
  if (-not (Test-Path -LiteralPath $reservationFile)) { return }
  $bounds = Get-PortBounds (Get-Content -LiteralPath $reservationFile -Raw)
  if ($bounds) {
    netsh interface ipv4 delete excludedportrange protocol=tcp startport=$($bounds[0]) numberofports=$($bounds[1] - $bounds[0] + 1) store=persistent | Out-Null
  }
  Remove-Item -LiteralPath $reservationFile -Force -ErrorAction SilentlyContinue
}

# Reserve the range (moving this script's earlier reservation, if it named
# another range). True when an administered exclusion covers it afterwards.
function Add-PortReservation([string]$Range) {
  $bounds = Get-PortBounds $Range
  if (-not $bounds) { return $false }
  $recorded = if (Test-Path -LiteralPath $reservationFile) { (Get-Content -LiteralPath $reservationFile -Raw).Trim() } else { "" }
  if ($recorded -and $recorded -ne $Range.Trim()) { Remove-PortReservation }
  if (-not (Test-PortsReserved $bounds[0] $bounds[1])) {
    netsh interface ipv4 add excludedportrange protocol=tcp startport=$($bounds[0]) numberofports=$($bounds[1] - $bounds[0] + 1) store=persistent | Out-Null
    if (-not (Test-PortsReserved $bounds[0] $bounds[1])) { return $false }
    Set-Content -LiteralPath $reservationFile -Value $Range.Trim() -Encoding ASCII
  }
  return $true
}

# Checked before the administrator prompt, so a bad call never asks for one.
if (-not $Uninstall -and -not $PortRange) {
  Write-Output "No -PortRange was given: pass the range the app chose for its egress proxy."
  exit 4
}

if (-not (Test-Admin)) {
  $argv = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  if ($PortRange) { $argv += @("-PortRange", $PortRange) }
  if ($Helper) { $argv += @("-Helper", "`"$Helper`"") }
  if ($SignerLike) { $argv += @("-SignerLike", "`"$SignerLike`"") }
  if ($Force) { $argv += "-Force" }
  if ($Uninstall) { $argv += "-Uninstall" }
  if ($RemoveHelper) { $argv += "-RemoveHelper" }
  try {
    $p = Start-Process -FilePath "powershell.exe" -ArgumentList $argv -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  } catch {
    Write-Output "The administrator prompt was cancelled."
    exit 10
  }
  exit $p.ExitCode
}

if ($Uninstall) {
  if (Test-Path $installed) {
    & $installed uninstall --sublayer-guid $SublayerGuid
    $code = $LASTEXITCODE
    if ($code -ne 0) { exit $code }
    if ($RemoveHelper) { Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Remove-PortReservation
  Write-Output "The cage is removed."
  exit 0
}

if (-not $Helper) { $Helper = $installed }
if (-not (Test-Path -LiteralPath $Helper)) {
  Write-Output "The cage helper was not found at $Helper."
  exit 2
}
if ($SignerLike -and (Test-Path -LiteralPath $SignerLike)) {
  $reference = Get-AuthenticodeSignature -LiteralPath $SignerLike
  if ($reference.Status -eq "Valid") {
    $sig = Get-AuthenticodeSignature -LiteralPath $Helper
    if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -cne $reference.SignerCertificate.Subject) {
      Write-Output "The cage helper's signature was rejected: status $($sig.Status), subject $($sig.SignerCertificate.Subject); expected the publisher of $SignerLike."
      exit 3
    }
  } else {
    Write-Output "The installer is unsigned (developer build); the helper's signature is not checked."
  }
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
if ((Resolve-Path -LiteralPath $Helper).Path -ne $installed) {
  Copy-Item -LiteralPath $Helper -Destination $installed -Force
}
$installArgs = @("install", "--sublayer-guid", $SublayerGuid, "--sandbox-user", $SandboxUser, "--proxy-port-range", $PortRange)
if ($Force) { $installArgs += "--force" }
& $installed @installArgs
$code = $LASTEXITCODE
if ($code -ne 0) { exit $code }
if (-not (Add-PortReservation $PortRange)) {
  Write-Output "The cage is installed, but Windows would not reserve ports $PortRange for it; a restart that hands them to another program will need a repair from Settings."
  exit 15
}
exit 0
