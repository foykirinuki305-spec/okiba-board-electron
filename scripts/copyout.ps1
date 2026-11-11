$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
function Write-CopyJson($value) {
 $json=$value|ConvertTo-Json -Depth 8 -Compress
 $ascii=[regex]::Replace($json,'[^\x00-\x7F]',[Text.RegularExpressions.MatchEvaluator]{param($m) '\u'+([int][char]$m.Value).ToString('x4')})
 [Console]::Out.WriteLine($ascii)
}
try {
 $line=[Console]::In.ReadLine()
 if($null -eq $line -or $line.Length -gt 1048576){throw 'copy-invalid-request-size'}
 $request=$line|ConvertFrom-Json
 if(@($request.sources).Count -lt 1 -or @($request.sources).Count -gt 1000 -or $request.destDir -isnot [string]){throw 'copy-invalid-request'}
 Add-Type -Path (Join-Path $PSScriptRoot 'copyout-native.cs')
 $results=@();foreach($source in $request.sources){if($source -isnot [string]){throw 'copy-invalid-source'};$results+= [OkibaCopyOutFiles]::Copy($source,$request.destDir)}
 Write-CopyJson @{ok=$true;results=$results}
} catch { Write-CopyJson @{ok=$false;reason=$_.Exception.Message};exit 1 }
