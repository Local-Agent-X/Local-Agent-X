<#
  Local Agent X - Windows shell network cage provisioning.

  The ONE implementation of "install the cage": the standalone installer runs
  it on a fresh install, the app runs it from Settings, and the uninstaller
  runs it with -Uninstall. It needs administrator rights, so when it is not
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
       the shell egress proxy's port range.

  Exit codes: the helper's own (0 installed, 10 UAC cancelled, 12 filters,
  13 different range already installed, 14 user), plus 2 helper missing and
  3 signature rejected (-SignerLike names a signed executable, normally the
  installer, whose publisher the helper must match).
#>
param(
  [string]$Helper = "",
  [string]$PortRange = "60090-60099",
  # The helper must be signed by the same publisher as this executable (the
  # installer that carried it). Nothing is checked when that executable is
  # itself unsigned: a developer build.
  [string]$SignerLike = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
# LAX's own sublayer and account, so a machine that also runs Anthropic's
# sandbox-runtime (its default sublayer, its srt-sandbox user) keeps both.
$SublayerGuid = "6f3b9c1e-4a7d-4e52-9c0b-2d8e5f1a7b34"
$SandboxUser = "lax-sandbox"
$binDir = Join-Path $env:ProgramData "Local Agent X\bin"
$installed = Join-Path $binDir "srt-win.exe"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  $argv = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-PortRange", $PortRange)
  if ($Helper) { $argv += @("-Helper", "`"$Helper`"") }
  if ($SignerLike) { $argv += @("-SignerLike", "`"$SignerLike`"") }
  if ($Uninstall) { $argv += "-Uninstall" }
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
    Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
  }
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
& $installed install --sublayer-guid $SublayerGuid --sandbox-user $SandboxUser --proxy-port-range $PortRange
exit $LASTEXITCODE
