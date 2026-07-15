; CLIProxy Quota Tray — per-user installer (no admin required)
; Deploys the packaged win32-x64 build to %LOCALAPPDATA%\CLIProxy Quota Tray.
; The app self-registers autostart on first launch (main.cjs ensureAutoStart),
; so the installer does not.
;
; Build (after `npm run package:win`):
;   makensis -DSRC="release/CLIProxy Quota Tray-win32-x64" \
;            -DOUTFILE="release/CLIProxy-Quota-Tray-Setup.exe" scripts/installer.nsi

!ifndef SRC
  !define SRC "..\release\CLIProxy Quota Tray-win32-x64"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\release\CLIProxy-Quota-Tray-Setup.exe"
!endif
!ifndef APPVERSION
  !define APPVERSION "1.0.1"
!endif

Unicode true
Name "CLIProxy Quota Tray"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\CLIProxy Quota Tray"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CLIProxy Quota Tray"

Page directory
Page instfiles

UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  ; stop a running instance so files can be replaced
  ExecWait 'taskkill /F /T /IM "CLIProxy Quota Tray.exe"'
  ClearErrors

  SetOutPath "$INSTDIR"
  File /r "${SRC}/*"

  CreateShortcut "$SMPROGRAMS\CLIProxy Quota Tray.lnk" "$INSTDIR\CLIProxy Quota Tray.exe"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "CLIProxy Quota Tray"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "CLIProxy Quota Tray"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\CLIProxy Quota Tray.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  Exec '"$INSTDIR\CLIProxy Quota Tray.exe" --show'
SectionEnd

Section "Uninstall"
  ExecWait 'taskkill /F /T /IM "CLIProxy Quota Tray.exe"'
  ClearErrors

  ; remove autostart artifacts the app registers at runtime
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CLIProxy Quota Tray"
  Delete "$SMSTARTUP\CLIProxy Quota Tray.lnk"
  Delete "$SMSTARTUP\CLIProxy Quota Tray.cmd"
  Delete "$SMSTARTUP\CLIProxy Quota Tray.vbs"
  Delete "$SMPROGRAMS\CLIProxy Quota Tray.lnk"

  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"

  ; settings + usage history at %APPDATA%\CLIProxy Quota Tray are kept on purpose
  DetailPrint "User data in AppData\Roaming\CLIProxy Quota Tray was preserved."
SectionEnd
