$ErrorActionPreference='Stop'
$s=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$a=$s.IndexOf('function Confirm-CalibrationGrid(');$b=$s.IndexOf('function Position-DesktopPlan(',$a);Invoke-Expression $s.Substring($a,$b-$a)
$a=$s.IndexOf('function Strict-GeometryKey(');$b=$s.IndexOf('function Strict-AreaGrid(',$a);Invoke-Expression $s.Substring($a,$b-$a)
$count=0
function Check($v,$m){if(-not $v){throw $m};$script:count++}
$rows=@();foreach($axis in @('x','y')){foreach($pass in @('forward','reverse')){foreach($n in @(0,1,2,3,4,5)){$r=@{axis=$axis;pass=$pass;requestX=5;requestY=5;x=0;y=0};$r[$axis]=[int][Math]::Floor($n/2)*10;if($axis -eq 'x'){$r.requestX=$n*5}else{$r.requestY=$n*5};$rows+=$r}}}
$e=@{samples=$rows;maxSpacing=@{x=20;y=20}};$g=@{sx=10;sy=10;gx=0;gy=0}
Check (Confirm-CalibrationGrid $e $g) 'valid plateau and reverse proof'
Check (-not (Confirm-CalibrationGrid $e @{sx=5;sy=10;gx=0;gy=0})) 'divisor grid cannot masquerade as measured step'
Check (-not (Confirm-CalibrationGrid $e @{sx=10;sy=10;gx=1;gy=0})) 'wrong grid origin'
$rows[-1].y=30;Check (-not (Confirm-CalibrationGrid $e $g)) 'reverse mismatch rejected';$rows[-1].y=20
Check (-not (Confirm-CalibrationGrid @{samples=@($rows|Where-Object pass -eq 'forward');maxSpacing=$e.maxSpacing} $g)) 'reverse evidence required'
Check (-not (Confirm-CalibrationGrid @{samples=$rows;maxSpacing=@{x=9;y=20}} $g)) 'measured step above safety limit'
$a=@{autoArrange=$false;snap=$true;sx=10;sy=10;viewDpi=96;origin=@{x=0;y=0};explorerPid=1;listviewHwnd=2;folderFlags=4;areas=@(@{left=0;top=0;right=500;bottom=500;scale=100;monitorOrigin=@{x=0;y=0};grid=$null})}
$k=Strict-GeometryKey $a;$a.areas[0].grid=$g;Check ($k -ceq (Strict-GeometryKey $a)) 'derived grid not physical geometry'
$a.explorerPid=3;Check ($k -cne (Strict-GeometryKey $a)) 'Explorer restart invalidates physical signature'
Check (Confirm-CalibrationGrid ($e|ConvertTo-Json -Depth 8|ConvertFrom-Json) ($g|ConvertTo-Json|ConvertFrom-Json)) 'JSON-restored evidence is validated'
# Cache import is tested against a synthetic snapshot; no Shell call exists.
$a=$s.IndexOf('function Import-DesktopCalibration(');$b=$s.IndexOf('function Position-DesktopPlan(',$a);Invoke-Expression $s.Substring($a,$b-$a)
$script:MockSnapshot=@{ok=$true;autoArrange=$false;snap=$true;sx=10;sy=10;viewDpi=96;origin=@{x=0;y=0};explorerPid=1;explorerStarted='123';listviewHwnd=2;folderFlags=4;areas=@(@{left=0;top=0;right=500;bottom=500;scale=100;monitorOrigin=@{x=0;y=0};grid=$null});icons=@()}
function Get-StrictDesktopSnapshot {return $script:MockSnapshot}
$script:CalibratedDesktopGrids=@{}
$entry=@{areaIndex=0;geometry=(Strict-GeometryKey $script:MockSnapshot);grid=$g;proof=$e;createdUtc=[DateTime]::UtcNow.ToString('o');expiresUtc=[DateTime]::UtcNow.AddHours(23).ToString('o')}
$r=Import-DesktopCalibration 1 @($entry);Check ($r.ok -and $r.accepted -eq 1) 'valid cache import without desktop operations'
$script:MockSnapshot.explorerStarted='124';$r=Import-DesktopCalibration 1 @($entry);Check ($r.rejected -eq 1) 'Explorer process start change rejects persisted cache'
$script:MockSnapshot.explorerStarted='123';$entry.expiresUtc=[DateTime]::UtcNow.AddSeconds(-1).ToString('o');$r=Import-DesktopCalibration 1 @($entry);Check ($r.rejected -eq 1) 'expired cache rejected'
$entry.expiresUtc=[DateTime]::UtcNow.AddHours(23).ToString('o');$script:MockSnapshot.icons=@(@{label='old';x=1;y=1});$r=Import-DesktopCalibration 1 @($entry);Check ($r.rejected -eq 1) 'off-grid existing icon rejects cache'
Write-Host "helper calibration: $count pure checks passed; no desktop calls"
