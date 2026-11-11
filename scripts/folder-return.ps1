$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
function Write-ReturnJson($value) {
 $json=$value|ConvertTo-Json -Depth 12 -Compress
 $ascii=[regex]::Replace($json,'[^\x00-\x7F]',[Text.RegularExpressions.MatchEvaluator]{param($m) '\u'+([int][char]$m.Value).ToString('x4')})
 [Console]::Out.WriteLine($ascii)
}
try {
 $line=[Console]::In.ReadLine()
 if($null -eq $line -or $line.Length -gt 4194304){throw 'return-invalid-request-size'}
 $request=$line|ConvertFrom-Json
 if($request.action -notin @('prepare','execute','probe','finalize')){throw 'return-invalid-action'}
 Add-Type -Path (Join-Path $PSScriptRoot 'folder-return-native.cs')
 if($request.action -eq 'prepare') {
  if($request.sources -isnot [array] -or $request.sources.Count -lt 1 -or $request.sources.Count -gt 1000 -or $request.destDir -isnot [string]){throw 'return-invalid-request'}
  $items=@();$failed=@();$seen=@{}
  foreach($src in $request.sources){
   if($src -isnot [string] -or $seen.ContainsKey($src.ToLowerInvariant())){throw 'return-invalid-or-duplicate-source'};$seen[$src.ToLowerInvariant()]=$true
  }
  foreach($src in $request.sources){try{$items+= [OkibaFolderReturnFiles]::Prepare($src,$request.destDir)}catch{$failed+=@{src=$src;reason=$_.Exception.Message}}}
  Write-ReturnJson @{ok=$true;items=$items;failed=$failed}
 } else {
  if($request.items -isnot [array] -or $request.items.Count -lt 1 -or $request.items.Count -gt 1000){throw 'return-invalid-items'}
  $items=@();$seen=@{};$destSeen=@{}
  foreach($v in $request.items){
   $x=New-Object OkibaFolderReturnFiles+Item
   foreach($k in @('src','dest','identity','volume','size','mtime','sourceAncestorKey','destAncestorKey')){if($v.$k -isnot [string] -or [string]::IsNullOrEmpty($v.$k)){throw 'return-invalid-field'};$x.$k=$v.$k}
   if($v.attributes -notin @(32,34)){throw 'return-invalid-attributes'};$x.attributes=[uint32]$v.attributes
   if($seen.ContainsKey($x.src.ToLowerInvariant()) -or $destSeen.ContainsKey($x.dest.ToLowerInvariant())){throw 'return-duplicate-item'};$seen[$x.src.ToLowerInvariant()]=$true;$destSeen[$x.dest.ToLowerInvariant()]=$true;$items+=,$x
  }
  $results=@();foreach($x in $items){
   if($request.action -eq 'execute'){$results+= [OkibaFolderReturnFiles]::Execute($x)}
   elseif($request.action -eq 'finalize'){$results+= [OkibaFolderReturnFiles]::FinalizeDestination($x)}
   else{$results+= [OkibaFolderReturnFiles]::Probe($x)}
  }
  Write-ReturnJson @{ok=$true;results=$results}
 }
} catch {Write-ReturnJson @{ok=$false;reason=$_.Exception.Message};exit 1}