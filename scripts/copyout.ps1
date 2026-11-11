$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
 $line=[Console]::In.ReadLine()
 if($null -eq $line -or $line.Length -gt 1048576){throw 'copy-invalid-request-size'}
 $request=$line|ConvertFrom-Json
 if(@($request.sources).Count -lt 1 -or @($request.sources).Count -gt 1000 -or $request.destDir -isnot [string]){throw 'copy-invalid-request'}
 Add-Type -Path (Join-Path $PSScriptRoot 'copyout-native.cs')
 $results=@();foreach($source in $request.sources){if($source -isnot [string]){throw 'copy-invalid-source'};$results+= [OkibaCopyOutFiles]::Copy($source,$request.destDir)}
 [Console]::Out.WriteLine((@{ok=$true;results=$results}|ConvertTo-Json -Depth 8 -Compress))
} catch { [Console]::Out.WriteLine((@{ok=$false;reason=$_.Exception.Message}|ConvertTo-Json -Compress));exit 1 }
