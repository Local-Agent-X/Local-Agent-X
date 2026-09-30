<#
  Windows shell network cage - escape matrix.

  Runs the probes AS the sandbox account through the helper's exec, the way
  Local Agent X runs a shell, and asserts the fence's contract. Each probe
  targets something observable on this machine; nothing leaves it. Run in
  CI on an elevated runner after `provision.ps1`, and by hand on a box where
  the cage is installed.

  The contract this pins (2026-09-29):
    held  - a direct dial to a loopback port outside the permit
    held  - BITS (the service refuses the sandbox logon)
    held  - ShellExecute on a URL (no hand-off to another app)
    held  - SMB over the redirector (no network logon right)
    inert - a scheduled task can be registered but never runs (no batch
            logon right); "Last Result" stays "has not run"
    LEAK  - names resolve through the Windows resolver service, which the
            fence cannot attribute to a user. Asserted as still-leaking so
            that the day it is closed the assertion is flipped on purpose.

  Exit 0 when the contract holds, 1 with the first broken line named.
#>
param(
  [Parameter(Mandatory = $true)] [string]$Helper,
  [int]$OutsidePort = 7007
)

$ErrorActionPreference = "Continue"
$sysroot = $env:SystemRoot
$ps = "$sysroot\System32\WindowsPowerShell\v1.0\powershell.exe"
$probeDir = Join-Path $env:ProgramData "Local Agent X\probes"
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null

# A listener outside the permit, so "held" is observable as a refused connect.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $OutsidePort)
try { $listener.Start() } catch { Write-Output "cannot listen on 127.0.0.1:$OutsidePort ($($_.Exception.Message)); using it as an unlistened port"; $listener = $null }

$probe = Join-Path $probeDir "cage-probes.ps1"
@'
$ErrorActionPreference = "Continue"
function Say($s) { Write-Output $s }
Say ("identity=" + (whoami))
try { Invoke-WebRequest -Uri ("http://127.0.0.1:" + $args[0] + "/?probe=direct") -UseBasicParsing -TimeoutSec 4 | Out-Null; Say "direct=REACHED" } catch { Say "direct=BLOCKED" }
try { [System.Net.Dns]::GetHostAddresses("example.com") | Out-Null; Say "dns=RESOLVED" } catch { Say "dns=FAILED" }
try {
  $job = Start-BitsTransfer -Source ("http://127.0.0.1:" + $args[0] + "/?probe=bits") -Destination (Join-Path $env:TEMP "cage-bits") -Asynchronous -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline -and $job.JobState -in @("Connecting", "Transferring", "Queued")) { Start-Sleep -Milliseconds 500 }
  if ($job.JobState -eq "Transferred") { Say "bits=REACHED" } else { Say ("bits=BLOCKED(" + $job.JobState + ")") }
  Remove-BitsTransfer -BitsJob $job -ErrorAction SilentlyContinue
} catch { Say "bits=BLOCKED" }
try { Start-Process ("http://127.0.0.1:" + $args[0] + "/?probe=url") -ErrorAction Stop; Say "shellexecute=LAUNCHED" } catch { Say "shellexecute=BLOCKED" }
$smb = Start-Job { Test-Path "\\127.0.0.1\IPC$" }
if (Wait-Job $smb -Timeout 8) { if (Receive-Job $smb) { Say "smb=REACHED" } else { Say "smb=BLOCKED" } } else { Say "smb=BLOCKED"; Stop-Job $smb }
$marker = Join-Path $env:TEMP "cage-task-ran.txt"
Remove-Item $marker -ErrorAction SilentlyContinue
& schtasks /create /tn lax-cage-probe /tr ('cmd /c echo ran > "' + $marker + '"') /sc once /st 23:59 /f 2>&1 | Out-Null
& schtasks /run /tn lax-cage-probe 2>&1 | Out-Null
Start-Sleep 5
$ran = Test-Path $marker
& schtasks /delete /tn lax-cage-probe /f 2>&1 | Out-Null
Say ("schtasks=" + $(if ($ran) { "RAN" } else { "INERT" }))
'@ | Set-Content -LiteralPath $probe -Encoding ASCII

# The helper starts the child in the caller's working directory, which the
# sandbox account must be able to use: a folder under a user profile is not.
Push-Location $probeDir
try {
  $out = & $Helper exec --quiet --env "SYSTEMROOT=$sysroot" --env "PATH=$sysroot\System32;$sysroot;$sysroot\System32\WindowsPowerShell\v1.0" -- $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probe $OutsidePort 2>&1 | ForEach-Object { "$_" }
} finally {
  Pop-Location
  if ($listener) { $listener.Stop() }
}
$out | ForEach-Object { Write-Output "  $_" }

$expected = @{
  "direct" = "BLOCKED"; "dns" = "RESOLVED"; "bits" = "BLOCKED"; "shellexecute" = "BLOCKED"; "smb" = "BLOCKED"; "schtasks" = "INERT"
}
$failed = $false
foreach ($key in $expected.Keys) {
  $line = $out | Where-Object { $_ -like "$key=*" } | Select-Object -First 1
  $value = if ($line) { ($line -split "=", 2)[1] } else { "MISSING" }
  $ok = $value -like ($expected[$key] + "*")
  Write-Output ("{0,-13} {1,-24} {2}" -f $key, $value, $(if ($ok) { "ok" } else { "EXPECTED " + $expected[$key] }))
  if (-not $ok) { $failed = $true }
}
if ($failed) { exit 1 }
Write-Output "escape matrix: contract holds"
exit 0
