; clear-long-paths-stub.nsi - runs wrapper/build/installer.nsh's real TURBOLLM_CLEAR_LONG_PATHS
; against the folder passed with /D=, so installer-nsh.test.js can check what it deletes and keeps.
Unicode true
RequestExecutionLevel user
SilentInstall silent
!addincludedir "${TPL}"
; installer.nsh includes getProcessInfo.nsh, whose function only customCheckAppRunning calls.
!pragma warning disable 6010
!define APP_EXECUTABLE_FILENAME "TurboLLM.exe"
!include "LogicLib.nsh"
!include "${NSH}"
OutFile "${OUT}"
InstallDir "$TEMP\turbollm-clear-long-paths-stub-default"
Var CmdPath
Section
  StrCpy $CmdPath "$SYSDIR\cmd.exe"
  !insertmacro TURBOLLM_CLEAR_LONG_PATHS
SectionEnd
