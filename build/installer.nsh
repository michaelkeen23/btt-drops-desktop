; Custom NSIS hooks for the BTT Drops installer.
;
; THE PROBLEM THIS SOLVES
; ----------------------
; BTT Drops is a tray app: closing its window HIDES it (main.js intercepts the close event) so alerts keep
; coming. electron-builder's stock "is the app running?" check asks the app to close by sending its windows
; a WM_CLOSE and waiting. Our window swallows that by design, so the check can never succeed and the
; installer stops with:
;
;     BTT Drops cannot be closed. Please close it manually and click Retry.
;
; ...and there is nothing obvious to close, because the app only lives in the tray. If you click through it
; anyway, the uninstall step then fails ("failed to uninstall old application files") because the running
; process still holds its own files open.
;
; So: terminate it outright before doing anything. There is no state to lose — the app is a shell around
; the live web page, and its settings live in %APPDATA%, which an upgrade never touches.
;
; This runs in THREE places on purpose. preInit fires before electron-builder's running-app check (which is
; the one that was failing), customInit covers the assisted-installer path, and customUnInit covers the
; uninstaller — including the silent uninstall an upgrade runs to clear the old version.

!macro bdKillRunningApp
  DetailPrint "Closing BTT Drops if it is running…"
  ; /T also takes the GPU + renderer + hidden audio child processes with it.
  nsExec::Exec `taskkill /F /IM "BTT Drops.exe" /T`
  Pop $0
  ; Give Windows a moment to actually release the file handles before the uninstall step runs.
  Sleep 1500
!macroend

!macro preInit
  !insertmacro bdKillRunningApp
!macroend

!macro customInit
  !insertmacro bdKillRunningApp
!macroend

!macro customUnInit
  !insertmacro bdKillRunningApp
!macroend
