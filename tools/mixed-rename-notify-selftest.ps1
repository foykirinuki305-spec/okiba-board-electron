# Pure mocks only: never invokes the native notification method or Desktop APIs.
$ErrorActionPreference='Stop'
Invoke-Expression ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mixed-lease-native-ci.ps1')))
Invoke-Expression ([IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot) 'scripts/resident-lease.ps1')))
$script:calls=0;$script:bad=$false
function Mixed-RenameNotification($oldPath,$newPath){if($oldPath -cne 'C:\Desktop\a.txt' -or $newPath -cne 'C:\Board\a.txt'){throw 'wrong notification direction'};$script:calls++}
function Resident-Locate($r){if($script:bad){throw 'locator-unknown'};return $script:located}
$r=@{source='C:\Board\a.txt';destination='C:\Desktop\a.txt';identity='id';volume='v';size='1';mtime='2';originalAttributes=32}
function Reset-Record {$script:located=@{state='unmoved';record=@{identity='id';volume='v';size='1';mtime='2';attributes=32}};$script:calls=0;$script:bad=$false}
function Reject([scriptblock]$body){$failed=$false;try{& $body|Out-Null}catch{$failed=$true};if(-not $failed -or $script:calls -ne 0){throw 'expected pre-notification rejection'}}
Reset-Record;$null=Mixed-NotifyRestored $r 'moved';if($script:calls -ne 1){throw 'expected exactly one notification'}
Reset-Record;Reject {Mixed-NotifyRestored $r 'unmoved'}
Reset-Record;$script:located.state='moved';Reject {Mixed-NotifyRestored $r 'moved'}
Reset-Record;$script:bad=$true;Reject {Mixed-NotifyRestored $r 'moved'}
foreach($field in @('identity','volume','size','mtime')){Reset-Record;$script:located.record[$field]='changed';Reject {Mixed-NotifyRestored $r 'moved'}}
Reset-Record;$script:located.record.attributes=34;Reject {Mixed-NotifyRestored $r 'moved'}
Reset-Record;$script:located.record.attributes=33;Reject {Mixed-NotifyRestored $r 'moved'}
$cs=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mixed-rename-notify-ci.cs'));Add-Type -TypeDefinition $cs
if($cs -notmatch 'ExactSpelling=true' -or $cs -notmatch 'Notify\(0x00000001,0x00001005,oldPath,newPath\)' -or $cs -match '\.Refresh\('){throw 'notification contract changed'}
Write-Output 'PASS 10 notification proof cases + C# compile/static contract; no native notification invoked'
