; ECANDI installer customization (Session 11).
; electron-builder writes a complete Add/Remove Programs entry except for
; InstallLocation, which Windows Settings uses to show where an app lives and
; how big it is. Filling it in is the difference between an entry that looks
; like a real installed application and one that looks like an unpacked zip.
;
; SHCTX is whichever hive this install is using; ECANDI is per-user, so this
; lands in HKCU alongside everything else electron-builder wrote.

!macro customInstall
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
!macroend
