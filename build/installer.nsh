; Always install for the current user only (no admin rights, no "install for all users" page).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
