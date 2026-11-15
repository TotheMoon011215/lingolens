' LingoLens launcher: starts the app without a console window.
' Paths are derived from this script's own location, so the folder can be moved.
Option Explicit

Dim fso, sh, root, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Cannot find Electron runtime:" & vbCrLf & exe, 16, "LingoLens"
  WScript.Quit 1
End If

' Belt and braces: some shells export ELECTRON_RUN_AS_NODE, which would make
' Electron behave like plain Node and the app would fail to start.
On Error Resume Next
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

sh.CurrentDirectory = root
' Window style 1: electron.exe is a GUI subsystem binary, so no console flashes
' anyway. Style 0 would hide the app's own window as well.
sh.Run """" & exe & """ """ & root & """", 1, False
