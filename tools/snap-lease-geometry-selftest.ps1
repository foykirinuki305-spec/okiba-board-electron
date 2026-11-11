$ErrorActionPreference='Stop'
# Pure regression: extract only the signature function, never load native/Desktop code.
$t=$null;$e=$null
$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'snap-lease-common-ci.ps1'),[ref]$t,[ref]$e)
if($e){throw ($e|Out-String)}
$f=$a.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Lease-Geometry'},$true)
Invoke-Expression $f.Extent.Text
$s=@{explorerPid=1;explorerStarted='start';listviewHwnd=2;origin=[ordered]@{y=3;x=4};viewDpi=96;sx=101;sy=67;areas=@(@{left=0;top=0;right=1920;bottom=1080;scale=100;monitorOrigin=[ordered]@{y=6;x=5}})}
$j=$s|ConvertTo-Json -Depth 10|ConvertFrom-Json
$j.origin=[pscustomobject][ordered]@{x=4;y=3};$j.areas[0].monitorOrigin=[pscustomobject][ordered]@{x=5;y=6}
if((Lease-Geometry $s) -cne (Lease-Geometry $j)){throw 'property order regression'}
foreach($field in @('sx','sy')){$j.$field++;if((Lease-Geometry $s) -ceq (Lease-Geometry $j)){throw "missed $field"};$j.$field--}
$j.areas[0].monitorOrigin.x++
if((Lease-Geometry $s) -ceq (Lease-Geometry $j)){throw 'missed monitor origin'}
'PASS lease geometry canonical order and sx/sy/monitor-origin guards (4 checks)'
