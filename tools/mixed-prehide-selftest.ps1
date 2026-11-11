# Pure order/guard mocks. No native classes, file mutation, Shell calls, or Desktop access.
$ErrorActionPreference='Stop'
Invoke-Expression ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mixed-lease-native-ci.ps1')))
function Mixed-Trace($phase,$detail){}
function Lease-Path($p){return $p}
function Lease-Snapshot{return @{folderFlags=4}}
function Lease-Guard($r,$s){if($script:oldChanged){throw 'old-changed'};return @{}}
function Lease-SetHidden($record,$hidden){$script:notifications+=,$record.path;$script:hidden[$record.path]=$hidden}
function Lease-CheckRecord($record){return @{hidden=$script:hidden[$record.path]}}
function Resident-Locate($r){$state=$script:states[$r.identity];if($state -eq 'unknown'){throw 'unknown-location'};return @{state=$state;record=@{hidden=$script:hidden[$r.destination];attributes=([uint32]$r.originalAttributes -bor $(if($script:hidden[$r.destination]){2}else{0}))}}}
function Mixed-WaitVisibility($r,$visible){if($script:waitFail){throw 'visibility-not-zero'};return @{folderFlags=4}}
$r=@{linkRecords=@(@{path='link';identity='l';attributes=34});residentRecords=@(@{destination='dest';source='src';identity='r';originalAttributes=32});records=@(@{path='link';identity='l';attributes=34},@{path='dest';identity='r';attributes=32})}
$original=$r|ConvertTo-Json -Depth 8 -Compress
function Reset {$script:oldChanged=$false;$script:waitFail=$false;$script:notifications=@();$script:hidden=@{link=$false;dest=$false};$script:states=@{r='moved'};$script:renameCount=0}
function SimulateRestore { $null=Mixed-HideBeforeRestore $r; $script:renameCount++ }
function Reject([scriptblock]$b){$failed=$false;try{& $b}catch{$failed=$true};if(-not $failed -or $script:renameCount){throw 'rename before verified zero'}}
Reset;SimulateRestore;if($script:renameCount -ne 1 -or ($script:notifications -join ',') -cne 'link,dest'){throw 'expected ordered group hide'}
if(($r|ConvertTo-Json -Depth 8 -Compress) -cne $original){throw 'original attributes mutated'}
Reset;$script:waitFail=$true;Reject {SimulateRestore}
Reset;$script:oldChanged=$true;Reject {SimulateRestore};if($script:notifications.Count){throw 'attribute mutation before initial old guard'}
Reset;$script:states.r='unmoved';SimulateRestore;if(($script:notifications -join ',') -cne 'link'){throw 'unmoved destination touched'}
Reset;$script:states.r='unknown';Reject {SimulateRestore}
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mixed-lease-native-ci.ps1'));$body=$source.Substring($source.IndexOf('function Lease-Rollback('));$body=$body.Substring(0,$body.IndexOf('function Lease-Release('))
if($body.IndexOf('Mixed-HideBeforeRestore') -lt 0 -or $body.IndexOf('Mixed-HideBeforeRestore') -gt $body.IndexOf('::RestoreMoved(')){throw 'native rename lacks group-zero prerequisite'}
Write-Output 'PASS 6 pure prehide/zero-before-rename/order/old guard/original metadata cases; native calls absent'
