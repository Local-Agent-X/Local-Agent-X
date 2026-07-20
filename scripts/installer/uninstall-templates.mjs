export const UNINSTALL_PS1 = String.raw`# Local Agent X uninstaller — registered by scripts/install-common.mjs.
param([switch]$FromTemp)
$ErrorActionPreference = 'SilentlyContinue'
$InstallDir = '__INSTALL_DIR__'
$RegKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalAgentX'

if (-not $FromTemp) {
  $tmp = Join-Path $env:TEMP 'lax-uninstall.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $tmp -Force
  Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $tmp + '"'),'-FromTemp'
  return
}

Add-Type -AssemblyName System.Windows.Forms
$nl = [Environment]::NewLine
$ans = [System.Windows.Forms.MessageBox]::Show('Remove Local Agent X?' + $nl + $nl + 'Also delete your data (chats, memory, saved API keys)? Choose No to keep it for a future reinstall.', 'Uninstall Local Agent X', [System.Windows.Forms.MessageBoxButtons]::YesNoCancel, [System.Windows.Forms.MessageBoxIcon]::Warning)
if ($ans -eq [System.Windows.Forms.DialogResult]::Cancel) { return }

Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$paths = @($InstallDir, (Join-Path $env:APPDATA 'electron'), (Join-Path $env:APPDATA 'Local Agent X'))
if ($ans -eq [System.Windows.Forms.DialogResult]::Yes) { $paths += (Join-Path $env:USERPROFILE '.lax') }
foreach ($p in $paths) { if ($p -and (Test-Path -LiteralPath $p)) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue } }

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
foreach ($lnk in @((Join-Path $desktop 'Local Agent X.lnk'), (Join-Path $startMenu 'Local Agent X.lnk'))) { if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue } }

Remove-Item -LiteralPath $RegKey -Recurse -Force -ErrorAction SilentlyContinue
[System.Windows.Forms.MessageBox]::Show('Local Agent X has been removed.' + $nl + '(Ollama and the AI model were left installed.)', 'Uninstall complete', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
`;

export const UNINSTALL_COMMAND = String.raw`#!/bin/bash
# Local Agent X uninstaller (macOS). Removes the app + data; leaves Ollama.
SRC_DIR='__SOURCE_DIR__'
APP_DEST='__APP_DEST__'
SELF='__SELF__'

ANS=$(osascript <<'APPLESCRIPT'
try
  set q to display dialog "Remove Local Agent X?" & return & return & "Also delete your data (chats, memory, saved API keys)? Click Keep Data to keep it for a future reinstall." buttons {"Cancel", "Keep Data", "Delete Data"} default button "Keep Data" with icon caution with title "Uninstall Local Agent X"
  return button returned of q
on error
  return "Cancel"
end try
APPLESCRIPT
)
if [ "$ANS" = "Cancel" ] || [ -z "$ANS" ]; then exit 0; fi

osascript -e 'tell application "Local Agent X" to quit' >/dev/null 2>&1
pkill -f "Local Agent X.app" >/dev/null 2>&1
sleep 1

rm -rf "$APP_DEST"
rm -rf "$SRC_DIR"
rm -rf "$HOME/Library/Application Support/electron"
if [ "$ANS" = "Delete Data" ]; then rm -rf "$HOME/.lax"; fi
rm -f "$SELF"

osascript -e 'display dialog "Local Agent X has been removed." & return & "(Ollama and the AI model were left installed.)" buttons {"OK"} default button "OK" with title "Uninstall complete"' >/dev/null 2>&1
exit 0
`;
