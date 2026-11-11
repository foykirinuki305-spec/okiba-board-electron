# Only a disposable GitHub-hosted Windows runner may execute this test.
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Safe Desktop integration is restricted to GitHub-hosted Windows CI.'
}
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
foreach($block in [regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")) {
  Add-Type -TypeDefinition $block.Groups[1].Value
}
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class OkibaSafeTestStyle {
 [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd,int index,int value);
}
'@
$lv=[IntPtr]::Zero;$count=-1
foreach($v in [OkibaDesk]::FindDesktopListViews()) { $c=[OkibaDesk]::GetItemCount($v);if($c -gt $count){$lv=$v;$count=$c} }
if($lv -eq [IntPtr]::Zero){throw 'CI Explorer desktop unavailable: cannot prove safe placement.'}
$style=[OkibaDesk]::GetWindowLong($lv,-16)
$extended=[OkibaDesk]::SendMessage($lv,0x1037,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()
$exitCode=1
try {
  [void][OkibaSafeTestStyle]::SetWindowLong($lv,-16,($style -band (-bnot 0x0100)))
  [void][OkibaDesk]::SendMessage($lv,0x1036,[IntPtr]0x80000,[IntPtr]0x80000)
  Start-Sleep -Milliseconds 300
  & node (Join-Path $PSScriptRoot 'safe-desktop-test.js') ([Environment]::GetFolderPath('Desktop'))
  $exitCode=$LASTEXITCODE
} finally {
  [void][OkibaDesk]::SendMessage($lv,0x1036,[IntPtr]0x80000,[IntPtr]($extended -band 0x80000))
  [void][OkibaSafeTestStyle]::SetWindowLong($lv,-16,$style)
}
exit $exitCode
