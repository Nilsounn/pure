; Installateur Pure -- installation par utilisateur (aucun droit administrateur requis),
; raccourcis Menu Démarrer + Bureau, désinstalleur. Le lancement au démarrage de Windows
; est géré par l'application elle-même (Electron app.setLoginItemSettings), pas ici.
; L'enregistrement auprès de Windows (navigateur par défaut, fichiers .html) est écrit par Pure.exe
; lui-même : l'installateur le lance avec --register (et --unregister à la désinstallation).

Unicode true

; Version : makensis /DVERSION=1.14.1 installer.nsi (à défaut, la valeur ci-dessous)
!ifndef VERSION
  !define VERSION "1.14.0"
!endif

!include "MUI2.nsh"

Name "Pure"
Caption "Installation de Pure"
BrandingText "Pure — navigation rapide, personnalisation forte"
OutFile "dist\PureSetup.exe"
InstallDir "$LOCALAPPDATA\Programs\Pure"
InstallDirRegKey HKCU "Software\Pure" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "build\icon.ico"
!define MUI_UNICON "build\icon.ico"
!define MUI_ABORTWARNING

; --- Direction artistique Pure : rose, logo « P », titres Georgia italique ---
!define MUI_BGCOLOR "F7DEEA"
!define MUI_TEXTCOLOR "8C3459"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "build\installer-header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "build\installer-header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "build\installer-sidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "build\installer-sidebar.bmp"
!define MUI_DIRECTORYPAGE_BGCOLOR "FBF1F5"
!define MUI_DIRECTORYPAGE_TEXTCOLOR "8C3459"
!define MUI_INSTFILESPAGE_COLORS "8C3459 FBF1F5"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

Var PureTitleFont
!define MUI_FINISHPAGE_RUN "$INSTDIR\Pure.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Lancer Pure"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Choisir Pure comme navigateur par défaut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION OpenDefaultApps

!define MUI_WELCOMEPAGE_TITLE "Bienvenue sur PURE"
!define MUI_WELCOMEPAGE_TEXT "Ce guide installe Pure sur ton ordinateur.$\r$\n$\r$\nUn navigateur rapide, un bloqueur de pub intégré et une personnalisation forte : à toi de jouer.$\r$\n$\r$\nClique sur Suivant pour continuer."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow
!insertmacro MUI_PAGE_WELCOME

!define MUI_PAGE_HEADER_TEXT "Où installer Pure ?"
!define MUI_PAGE_HEADER_SUBTEXT "Choisis le dossier d'installation."
!insertmacro MUI_PAGE_DIRECTORY

!define MUI_PAGE_HEADER_TEXT "Installation de Pure"
!define MUI_PAGE_HEADER_SUBTEXT "Quelques secondes et c'est prêt."
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Installation terminée"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "Pure est prêt à décoller."
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Pure est prêt"
!define MUI_FINISHPAGE_TEXT "Pure est installé.$\r$\n$\r$\nMets-le en navigateur par défaut et profite d'une optimisation d'enfer couplée avec une personnalisation forte."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!insertmacro MUI_PAGE_FINISH

!define MUI_WELCOMEPAGE_TITLE "Désinstaller Pure"
!define MUI_WELCOMEPAGE_TEXT "Pure va être retiré de ton ordinateur. Tes favoris, ton historique et tes mots de passe restent dans ton dossier de données.$\r$\n$\r$\nClique sur Suivant pour continuer."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.WelcomeShow
!insertmacro MUI_UNPAGE_WELCOME

!define MUI_PAGE_HEADER_TEXT "Désinstallation de Pure"
!define MUI_PAGE_HEADER_SUBTEXT "Pure est en train d'être retiré."
!insertmacro MUI_UNPAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Pure a été désinstallé"
!define MUI_FINISHPAGE_TEXT "À bientôt !"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.FinishShow
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "French"

; Titres en Georgia italique, comme les titres du navigateur
!macro PureTitleFont CTRL
  CreateFont $PureTitleFont "Georgia" 18 400 /ITALIC
  SendMessage ${CTRL} ${WM_SETFONT} $PureTitleFont 0
!macroend
Function WelcomeShow
  !insertmacro PureTitleFont $mui.WelcomePage.Title
FunctionEnd
Function FinishShow
  !insertmacro PureTitleFont $mui.FinishPage.Title
FunctionEnd
Function un.WelcomeShow
  !insertmacro PureTitleFont $mui.WelcomePage.Title
FunctionEnd
Function un.FinishShow
  !insertmacro PureTitleFont $mui.FinishPage.Title
FunctionEnd

; Ferme Pure s'il tourne : fermeture normale d'abord, attente jusqu'à 10 s, puis arrêt forcé en dernier recours
!macro PureStopMacro UN
Function ${UN}PureStop
  nsExec::Exec 'taskkill /IM Pure.exe /T'
  StrCpy $R9 0
  ${UN}PureWait:
    nsExec::ExecToStack 'cmd /c tasklist /NH /FI "IMAGENAME eq Pure.exe" | find /I "Pure.exe"'
    Pop $R8
    Pop $R7
    StrCmp $R8 "0" 0 ${UN}PureGone
    IntOp $R9 $R9 + 1
    IntCmp $R9 20 ${UN}PureForce ${UN}PureSleep ${UN}PureForce
  ${UN}PureSleep:
    Sleep 500
    Goto ${UN}PureWait
  ${UN}PureForce:
    nsExec::Exec 'taskkill /F /IM Pure.exe /T'
  ${UN}PureGone:
FunctionEnd
!macroend
!insertmacro PureStopMacro ""
!insertmacro PureStopMacro "un."

; Mise à jour silencieuse (lancée par Pure avec /S) : on relance Pure à la fin
Function .onInstSuccess
  IfSilent 0 +2
    Exec '"$INSTDIR\Pure.exe"'
FunctionEnd

Function OpenDefaultApps
  ExecShell "open" "ms-settings:defaultapps?registeredAppUser=Pure"
FunctionEnd

Section "Pure" SEC01
  ; Mise à jour : on ferme proprement une éventuelle instance de Pure avant de remplacer les fichiers
  Call PureStop

  SetOutPath "$INSTDIR"
  File /r "dist\Pure-win32-x64\*.*"

  ; Enregistre Pure auprès de Windows : liste des navigateurs, liens http(s), fichiers .html/.htm/.xhtml/.svg
  ExecWait '"$INSTDIR\Pure.exe" --register'

  WriteRegStr HKCU "Software\Pure" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Pure"
  CreateShortcut "$SMPROGRAMS\Pure\Pure.lnk" "$INSTDIR\Pure.exe" "" "$INSTDIR\Pure.exe" 0
  CreateShortcut "$SMPROGRAMS\Pure\Désinstaller Pure.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Pure.lnk" "$INSTDIR\Pure.exe" "" "$INSTDIR\Pure.exe" 0

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure" "DisplayName" "Pure"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure" "DisplayIcon" "$INSTDIR\Pure.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure" "Publisher" "Pure"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure" "DisplayVersion" "${VERSION}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Call un.PureStop
  ; Retire les clés « navigateur / fichiers .html » écrites par Pure
  ExecWait '"$INSTDIR\Pure.exe" --unregister'
  DeleteRegKey HKCU "Software\Classes\PureHTML"
  DeleteRegKey HKCU "Software\Classes\PureURL"
  DeleteRegKey HKCU "Software\Classes\Applications\Pure.exe"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Pure"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Pure"
  ; Retire l'entrée de démarrage automatique que l'application avait créée
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Pure"

  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\Pure\Pure.lnk"
  Delete "$SMPROGRAMS\Pure\Désinstaller Pure.lnk"
  RMDir "$SMPROGRAMS\Pure"
  Delete "$DESKTOP\Pure.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pure"
  DeleteRegKey HKCU "Software\Pure"
SectionEnd
