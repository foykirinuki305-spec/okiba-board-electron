$ErrorActionPreference='Stop'
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$a=$source.IndexOf('function Strict-InferAreaGrid(')
$b=$source.IndexOf('function Get-RawStrictDesktopSnapshot',$a)
Invoke-Expression $source.Substring($a,$b-$a)
$one=@(@{x=43;y=2});$many=@(@{x=43;y=2},@{x=144;y=69})
$count=0
function Check($value,$message){if(-not $value){throw $message};$script:count++}
Check ($null -eq (Strict-InferAreaGrid @() 101 67 100 96)) 'empty monitor unknown'
Check ($null -eq (Strict-InferAreaGrid $one 101 67 150 96)) 'single icon at another DPI unknown'
Check ($null -eq (Strict-InferAreaGrid $many 101 67 150 96)) 'coincidental equal residues at another DPI unknown'
Check ($null -eq (Strict-InferAreaGrid $one 101 67 0 96)) 'unknown monitor DPI rejected'
Check ($null -eq (Strict-InferAreaGrid $one 101 67 100 0)) 'unknown view DPI rejected'
$g=Strict-InferAreaGrid $many 101 67 100 96
Check ($g.gx -eq 43 -and $g.gy -eq 2 -and $g.sx -eq 101 -and $g.sy -eq 67) 'matching view DPI measured origin'
Check ($null -eq (Strict-InferAreaGrid @(@{x=43;y=2},@{x=145;y=69}) 101 67 100 96)) 'inconsistent measured origins rejected'
$g=Strict-InferAreaGrid @(@{x=64;y=3},@{x=216;y=104}) 152 101 150 144
Check ($g.gx -eq 64 -and $g.gy -eq 3) '150 percent view DPI permitted only with corresponding view spacing'
Write-Host "helper grid: $count pure checks passed; no desktop calls"
