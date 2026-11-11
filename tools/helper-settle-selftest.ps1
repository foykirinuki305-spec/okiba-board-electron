$ErrorActionPreference='Stop'
$s=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$a=$s.IndexOf('function Wait-CalibrationSettled(');$b=$s.IndexOf('function Calibrate-DesktopGrid(',$a);Invoke-Expression $s.Substring($a,$b-$a)
function Strict-Near($a,$b){return [Math]::Abs($a.x-$b.x) -le 1 -and [Math]::Abs($a.y-$b.y) -le 1}
function Get-StrictDesktopSnapshot {if($script:reads.Count -gt 1){$r=$script:reads[0];$script:reads=@($script:reads|Select-Object -Skip 1);return $r};return $script:reads[0]}
function Get-RawStrictDesktopSnapshot {return $script:raw}
function Get-StrictTransactionState($baseline,$current,$targets){if($current.oldChanged){return @{ok=$false;reason='existing-icon-changed'}};return @{ok=$true;new=@{0=@{x=$current.x;y=$current.y}}}}
$good=@{ok=$true;x=50;y=50};$raw=$good;$patch=@{left=0;top=0;right=100;bottom=100};$n=0
function Check($v,$m){if(-not $v){throw $m};$script:n++}
$script:reads=@(@{ok=$false;reason='desktop-changing'},$good,$good)
$r=Wait-CalibrationSettled @{} @{} $patch ([Diagnostics.Stopwatch]::StartNew());Check $r.ok 'transient read retries then requires stable pair'
$script:reads=@(@{ok=$true;x=40;y=50},$good,$good)
$r=Wait-CalibrationSettled @{} @{} $patch ([Diagnostics.Stopwatch]::StartNew());Check ($r.ok -and $r.new[0].x -eq 50) 'own late snap settles before sample accepted'
$script:reads=@(@{ok=$true;x=50;y=50;oldChanged=$true})
$r=Wait-CalibrationSettled @{} @{} $patch ([Diagnostics.Stopwatch]::StartNew());Check ($r.reason -eq 'existing-icon-changed') 'old icon changes abort immediately'
$script:reads=@(@{ok=$true;x=101;y=50})
$r=Wait-CalibrationSettled @{} @{} $patch ([Diagnostics.Stopwatch]::StartNew());Check ($r.reason -eq 'calibration-left-patch') 'outside patch aborts'
$script:reads=@(@{ok=$false;reason='desktop-changing'});$script:raw=@{ok=$true;x=50;y=50;oldChanged=$true}
$r=Wait-CalibrationSettled @{} @{} $patch ([Diagnostics.Stopwatch]::StartNew());Check ($r.reason -eq 'existing-icon-changed') 'readable raw old-icon change is not hidden by unstable strict read'
Write-Host "helper settle: $n synthetic checks passed; no desktop calls"
