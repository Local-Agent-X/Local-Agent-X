; Local Agent X - NSIS customisation for the packaged (electron-builder) build.
;
; The packaged app is only half an installation. It is a thin Electron shell
; that resolves ~/.lax/config.json -> projectRoot and runs the real server and
; desktop main process from a source tree living somewhere else entirely.
; electron-builder's generated uninstaller only knows about its own Programs
; directory, so "uninstall" used to leave the source tree, the Electron user
; data, the shortcuts and a second Add/Remove row behind - and the user was
; left with an app that looked removed but still had ~600MB on disk and a row
; in Settings that did nothing.
;
; This hook hands the other half to the same script the standalone rescue path
; uses, so there is exactly one implementation of "what removing this app
; means" (scripts/uninstall/lax-uninstall.ps1).

!macro customUnInstall
  ; electron-builder runs the uninstaller during an in-place UPDATE too. Wiping
  ; the source tree there would brick the app we are about to reinstall, so the
  ; deep clean is gated on this being a real uninstall.
  ${ifNot} ${isUpdated}
    IfFileExists "$PROFILE\.lax\uninstall\lax-uninstall.ps1" lax_deep_clean lax_no_script

    lax_deep_clean:
      DetailPrint "Removing Local Agent X source tree, user data and shortcuts..."
      ; -Yes           : no prompts, and KEEP user data. Never destroy chats,
      ;                  memory or saved API keys from a silent uninstaller -
      ;                  a full reset is an explicit, separate opt-in.
      ; -SkipVendor... : we are that vendor uninstaller, mid-flight. The script
      ;                  leaves our own directory alone so the two don't race.
      ; -FromTemp      : run inline instead of re-launching detached, so this
      ;                  hook actually waits for the cleanup to finish.
      nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PROFILE\.lax\uninstall\lax-uninstall.ps1" -Yes -SkipVendorUninstaller -FromTemp'
      Pop $0
      DetailPrint "Local Agent X cleanup finished ($0)."
      Goto lax_done

    lax_no_script:
      ; No staged uninstaller (very old install, or ~/.lax already gone). Fall
      ; back to the paths we can name without it, so the common case still ends
      ; clean rather than leaving the user to hunt folders by hand.
      DetailPrint "Staged uninstaller not found - removing known paths."
      RMDir /r "$LOCALAPPDATA\Local Agent X"
      RMDir /r "$APPDATA\Local Agent X"
      RMDir /r "$APPDATA\electron"
      Delete "$DESKTOP\Local Agent X.lnk"
      Delete "$SMPROGRAMS\Local Agent X.lnk"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalAgentX"

    lax_done:
  ${endIf}
!macroend
