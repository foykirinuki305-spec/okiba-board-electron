# Pure wire-format regression. Never accesses Desktop or native APIs.
$ErrorActionPreference='Stop'
$bad=@{id=1;result=@{ok=$true;guard=@{ok=$true;new=@{0=@{x=483;y=394}};current=@{ok=$true}}}}
$rejected=$false
try{$null=$bad|ConvertTo-Json -Compress -Depth 8}catch{$rejected=$true}
if(-not $rejected){throw 'Expected numeric-key dictionary serialization to reject'}
foreach($ok in @($true,$false)){
 $result=@{ok=$ok;guard=@{ok=$ok;new=@{0=@{x=483;y=394}};current=@{ok=$true;icons=@(@{identity='old';x=15;y=2})}}}
 if($null -ne $result.guard.new){$wire=@{};foreach($key in $result.guard.new.Keys){$wire[[string]$key]=$result.guard.new[$key]};$result.guard.new=$wire}
 $json=@{id=1;result=$result}|ConvertTo-Json -Compress -Depth 8
 $parsed=$json|ConvertFrom-Json
 if($parsed.result.ok -ne $ok -or $parsed.result.guard.new.'0'.x -ne 483 -or $parsed.result.guard.current.icons[0].identity -cne 'old'){throw 'wire roundtrip changed data'}
}
Write-Output 'PASS: numeric-key failure reproduced, success/failure response roundtrips preserve guards'
