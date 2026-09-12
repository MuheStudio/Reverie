!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; electron-builder's createDesktopShortcut is left false so this include owns
; both the prompt and the AUMID-tagged shortcut. Default is checked.
; Variables stay inside the installer compile so the uninstaller does not
; warn about unused checkbox state.

!ifndef BUILD_UNINSTALLER
Var ReverieDesktopShortcutCheckbox
Var ReverieCreateDesktopShortcut

Function ReverieDesktopShortcutPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "安装完成后，是否在桌面创建快捷方式？ / Create a desktop shortcut after install?"
  Pop $0
  ${NSD_CreateCheckbox} 0 40u 100% 12u "创建桌面快捷方式 / Create a desktop shortcut"
  Pop $ReverieDesktopShortcutCheckbox
  ${If} $ReverieCreateDesktopShortcut == ${BST_UNCHECKED}
    ${NSD_SetState} $ReverieDesktopShortcutCheckbox ${BST_UNCHECKED}
  ${Else}
    ${NSD_SetState} $ReverieDesktopShortcutCheckbox ${BST_CHECKED}
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ReverieDesktopShortcutPageLeave
  ${NSD_GetState} $ReverieDesktopShortcutCheckbox $ReverieCreateDesktopShortcut
FunctionEnd
!endif

!macro customPageAfterChangeDir
  !ifndef BUILD_UNINSTALLER
    Page custom ReverieDesktopShortcutPage ReverieDesktopShortcutPageLeave
  !endif
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ${If} $ReverieCreateDesktopShortcut != ${BST_UNCHECKED}
      CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
      WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    ${EndIf}
  !endif
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
!macroend
