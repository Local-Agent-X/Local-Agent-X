# Build lax-speech-win.exe — Windows analogue of LaxSpeech.app.
#
# Uses csc.exe from .NET Framework (already installed on every Windows
# build agent and end-user machine since Windows 7). Avoids pulling a
# full .NET SDK into the build — System.Speech is part of the OS, so the
# compiled .exe is ~12KB and depends only on what's already there.

$ErrorActionPreference = 'Stop'

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir  = Join-Path $here '..\dist-bin'
$outExe  = Join-Path $outDir 'lax-speech-win.exe'

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# csc.exe ships with every .NET Framework 4.x install. Path is fixed by
# the framework version — pick the newest one available on this machine.
$cscCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
    throw "csc.exe not found. Install .NET Framework 4.x developer tools (ships with every modern Windows)."
}

# Resolve System.Speech.dll to a FULL path. The legacy csc.exe does not search
# the GAC by short name, so /reference:System.Speech.dll fails with CS0006 on
# any machine that has the runtime + GAC but not the .NET Framework
# reference-assembly pack (i.e. nearly every end-user box — the live install
# failure). The assembly itself is always present because System.Speech ships
# with the OS; we just have to hand csc its actual location. Prefer the GAC
# copy; fall back to the fusion loader via reflection.
$speechDll = Get-ChildItem "$env:WINDIR\Microsoft.NET\assembly\GAC_MSIL\System.Speech" `
    -Recurse -Filter 'System.Speech.dll' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $speechDll) {
    try {
        Add-Type -AssemblyName System.Speech -ErrorAction Stop
        $speechDll = [System.Speech.Synthesis.SpeechSynthesizer].Assembly.Location
    } catch { }
}
if (-not $speechDll -or -not (Test-Path $speechDll)) {
    throw "System.Speech.dll could not be located (GAC + reflection both failed)."
}

& $csc `
    /nologo `
    /target:exe `
    /platform:anycpu `
    /optimize+ `
    /reference:$speechDll `
    /out:$outExe `
    (Join-Path $here 'SpeechHelper.cs')

if ($LASTEXITCODE -ne 0) {
    throw "csc failed (exit $LASTEXITCODE)"
}

Write-Host "[win-speech] built $outExe"
