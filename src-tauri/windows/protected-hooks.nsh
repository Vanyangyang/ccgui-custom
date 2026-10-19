; Preserve the reviewed guarded entry when installing this custom build.
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$PROFILE\agent-assets\scripts\start-ccgui.ps1" 0 protected_hook_done
  CreateShortCut "$DESKTOP\CC GUI（代理保护）.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PROFILE\agent-assets\scripts\start-ccgui.ps1"' "$INSTDIR\ccgui-next.exe" 0
  Delete "$DESKTOP\CC GUI.lnk"
  protected_hook_done:
!macroend
