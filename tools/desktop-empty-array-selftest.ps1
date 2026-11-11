$ErrorActionPreference='Stop'
foreach($json in @('{"icons":[]}','{"icons":[{"identity":"a","x":1,"y":2}]}','{"icons":[{"identity":"a","x":1,"y":2},{"identity":"b","x":3,"y":4}]}')){
 $current=$json|ConvertFrom-Json;$ids=[string[]]@($current.icons|ForEach-Object{$_.identity});$xs=[int[]]@($current.icons|ForEach-Object{$_.x});$ys=[int[]]@($current.icons|ForEach-Object{$_.y});if($ids.Count -ne $current.icons.Count -or $xs.Count -ne $ids.Count -or $ys.Count -ne $ids.Count){throw 'array count mismatch'}
 for($i=0;$i -lt $ids.Count;$i++){if($ids[$i] -cne $current.icons[$i].identity -or $xs[$i] -ne $current.icons[$i].x -or $ys[$i] -ne $current.icons[$i].y){throw 'content mismatch'}}
}
Write-Host 'empty/single/multiple native argument projection 3 cases PASS (no Desktop)'
$source=Get-Content (Join-Path $PSScriptRoot 'desktop-dpi-empty-ci.ps1') -Raw
$condition=[regex]::Match($source,'\$nativeVerified=\((\$exitKnown[^;]+)\);').Groups[1].Value
if(-not $condition){throw 'restore gate extraction failed'}
foreach($c in @(@($true,$true,$false,$true,$false,$true),@($true,$false,$true,$true,$false,$true),@($false,$true,$false,$true,$false,$false),@($true,$false,$false,$true,$false,$false),@($true,$true,$false,$false,$false,$false),@($true,$true,$false,$true,$true,$false))){
 $exitKnown=$c[0];$n=[pscustomobject]@{passed=$c[1];failureRecoveryVerified=$c[2];cleanupVerified=$c[3];cleanupError=$(if($c[4]){'failure'}else{$null});actualScale=150;cases=@('success','no-fit')}
 $allowed=Invoke-Expression $condition;if($allowed -ne $c[5]){throw 'unsafe UI restoration gate'}
}
Write-Host 'UI restore gate 6 cases PASS: proved abort distinct from test success'
