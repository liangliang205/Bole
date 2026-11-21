; 覆盖安装时的自我保护：
; 1) 结束正在运行的旧实例（它可能锁住 BoLe.exe / Uninstall BoLe.exe）
; 2) 删除可能残留的只读卸载器，避免 "不能打开要写入的文件"
!macro customInit
  nsExec::Exec 'taskkill /F /IM BoLe.exe'
  Pop $0
  Delete /REBOOTOK "$INSTDIR\Uninstall BoLe.exe"
!macroend
