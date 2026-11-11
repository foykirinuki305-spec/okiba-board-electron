# Read-only COM/session compatibility test. Never calls a setter or positions icons.
$ErrorActionPreference='Stop'
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
Invoke-Expression ($source.Substring(0,$source.IndexOf('# ---- Main loop')))
$dpi=[OkibaWin32]::EnterPhysicalScope();$session=$null
try {
 $snapshot=Get-StrictDesktopSnapshot;if(-not $snapshot.ok){throw ('read-only snapshot '+$snapshot.reason)}
 $type=[OkibaFolderView].GetNestedType('Session',[Reflection.BindingFlags]'NonPublic')
 $session=[Activator]::CreateInstance($type,$true)
 $method=[OkibaFolderView].GetMethod('AssertLeaseSession',[Reflection.BindingFlags]'NonPublic,Static')
 $null=$method.Invoke($null,[object[]]@($session,[long]$snapshot.listviewHwnd,[int]$snapshot.explorerPid,[string]$snapshot.explorerStarted))
 Write-Host 'ok - official IShellView window / Explorer generation read-only assertion'
 $blocked=$false
 try{$null=$method.Invoke($null,[object[]]@($session,[long]$snapshot.listviewHwnd,[int]$snapshot.explorerPid,'0'))}catch{$inner=$_.Exception;while($inner.InnerException){$inner=$inner.InnerException};$blocked=$inner.Message -eq 'lease-explorer-changed'}
 if(-not $blocked){throw 'wrong Explorer birth accepted'}
 Write-Host 'ok - wrong Explorer birth rejected without mutation'
 $blocked=$false
 try{$null=$method.Invoke($null,[object[]]@($session,[long]0,[int]$snapshot.explorerPid,[string]$snapshot.explorerStarted))}catch{$inner=$_.Exception;while($inner.InnerException){$inner=$inner.InnerException};$blocked=$inner.Message -eq 'lease-view-changed'}
 if(-not $blocked){throw 'wrong listview accepted'}
 Write-Host 'ok - wrong view rejected without mutation'
}finally{if($session){$session.Dispose()};[OkibaWin32]::LeavePhysicalScope($dpi)}
