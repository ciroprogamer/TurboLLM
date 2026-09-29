; installer-stub.nsi - compiles wrapper/build/installer.nsh against the real stock electron-builder
; NSIS includes, in installer mode and (with -DBUILD_UNINSTALLER) uninstaller mode. Used by
; installer-nsh.test.js as a fast -WX syntax/contract check; it never packages or runs a real app.
Unicode true
RequestExecutionLevel user
!addincludedir "${TPL}"
!define APP_EXECUTABLE_FILENAME "TurboLLM.exe"
!define PRODUCT_NAME "TurboLLM"
!macro _isUpdated _a _b _t _f
  StrCmp "" "x" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`
LangString appRunning 1033 "stub"
LangString appClosing 1033 "stub"
LangString appCannotBeClosed 1033 "stub"
LangString installing 1033 "stub"
!include "LogicLib.nsh"
!include "${NSH}"
!include "allowOnlyOneInstallerInstance.nsh"
OutFile "${OUT}"
!ifdef BUILD_UNINSTALLER
  Function un.checkAppRunning
    !insertmacro CHECK_APP_RUNNING
  FunctionEnd
  Section "install"
    WriteUninstaller "$TEMP\stub-never-run.exe"
  SectionEnd
  Section "un.Uninstall"
    Call un.checkAppRunning
  SectionEnd
!else
  Section "install"
    !insertmacro CHECK_APP_RUNNING
  SectionEnd
!endif
