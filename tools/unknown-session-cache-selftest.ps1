$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\unknown-grid-success.ps1')
# IO-free mocks for snapshot/validator/session. The real binding/cache policy is exercised.
$env:OKIBA_UNKNOWN_GRID_LEASE='1';$script:SnapLease=$null;$script:n=0
function Check($b,$why){if(-not $b){throw $why};$script:n++}
function Strict-GeometryKey($s){return (@($s.explorerPid,$s.explorerStarted,$s.listviewHwnd,$s.folderFlags,$s.sx,$s.sy,$s.viewDpi,$s.origin.x,$s.origin.y,@($s.areas|ForEach-Object{@($_.left,$_.top,$_.right,$_.bottom,$_.scale)}))|ConvertTo-Json -Depth 10 -Compress)}
function Lease-PhysicalKey($s){$c=$s|ConvertTo-Json -Depth 20|ConvertFrom-Json;$c.folderFlags=4;return Strict-GeometryKey $c}
function Strict-IconsKey($s){return (@($s.icons|ForEach-Object{@($_.identity,$_.x,$_.y)})|ConvertTo-Json -Depth 8 -Compress)}
function Strict-PointValid($p){return ($null -ne $p.x -and $null -ne $p.y -and [double]$p.x -eq [int]$p.x -and [double]$p.y -eq [int]$p.y)}
function Lease-AllGrid($b,$s){foreach($i in $s.icons){$a=@($b.areas|Where-Object{$i.x -ge $_.left -and $i.x -lt $_.right -and $i.y -ge $_.top -and $i.y -lt $_.bottom});if($a.Count -ne 1 -or $null -eq $a[0].grid){throw 'grid'};$g=$a[0].grid;if((($i.x-$g.gx)%$g.sx) -ne 0 -or (($i.y-$g.gy)%$g.sy) -ne 0){throw 'offgrid'}}}
function Lease-Snapshot {return $script:fresh}
function Unknown-Live($r){if($script:dead){throw 'owner-dead'}}
function Unknown-ValidateSuccess($r){Unknown-AssertProofBinding $r;return @{grid=$r.success.resolved.grid}}
function Unknown-Current($r){return $script:fresh}
function Lease-Guard($r,$s,$exact){return @{}}
function New-Case {
 $script:dead=$false;$script:SnapLease=$null;$script:UnknownSessionGrids=@{};$script:UnknownSessionCandidates=@{}
 $grid=@{sx=113;sy=161;gx=20;gy=2};$s=@{ok=$true;identityVersion=1;explorerPid=42;explorerStarted='123';listviewHwnd=12;folderFlags=4;autoArrange=$false;shellAutoArrange=$false;snap=$true;sx=75;sy=107;viewDpi=96;origin=@{x=0;y=0};areas=@(@{left=0;top=0;right=1920;bottom=1080;scale=150;grid=$null});icons=@()}
 $r=@{token='original';snapshot=$s;originalFlags=4;records=@(@{path='owned'});targetAreaIndex=0;success=@{bindingFormat='sha256-utf8-v1';baseline=($s|ConvertTo-Json -Depth 20|ConvertFrom-Json);samples=@(@{id=0});resolved=@{grid=$grid}}}
 $r.success.binding=@{token=$r.token;probeId='owned';geometryKey=(Unknown-BindingDigest (Strict-GeometryKey $s));iconsKey=(Unknown-BindingDigest (Strict-IconsKey $s))}
 $script:fresh=$s|ConvertTo-Json -Depth 20|ConvertFrom-Json;$script:fresh.icons=@(@{identity='old-A';x=20;y=2})
 $script:UnknownNativeLedgerOrigins=@{};$script:UnknownNativeLedgerOrigins[$r.token]=@{record=$r;sampleKeys=@((Unknown-BindingDigest ($r.success.samples[0]|ConvertTo-Json -Depth 8 -Compress)))}
 return $r
}
function Activate($r){$id=Unknown-ProvisionSessionGrid $r;$result=Unknown-CommitSessionGrid @{token=$r.token;candidateId=$id};Check $result.ok 'activation';return $id}
$r=New-Case;$before=$r|ConvertTo-Json -Depth 24 -Compress;$id=Unknown-ProvisionSessionGrid $r
Check ($script:UnknownSessionGrids.Count -eq 0) 'provisional not active';Check ($null -eq (Apply-UnknownSessionGrids $script:fresh).areas[0].grid) 'provisional not applied'
$null=Unknown-CommitSessionGrid @{token=$r.token;candidateId=$id};$out=Apply-UnknownSessionGrids $script:fresh
Check ($out.areas[0].grid.sx -eq 113) 'active applied';Check ($null -eq $script:fresh.areas[0].grid) 'fresh source untouched';Check (($r|ConvertTo-Json -Depth 24 -Compress) -ceq $before) 'proof and baseline unchanged'
$script:fresh.icons+=@{identity='new-previous';x=246;y=324};$out=Apply-UnknownSessionGrids $script:fresh;Check (@($out.icons).Count -eq 2 -and $out.areas[0].grid.sy -eq 161) 'fresh prior icons retained'
foreach($change in @('token','probe','baseline','recordsnapshot','sample','flags','pid','birth','hwnd','scale','spacing','offgrid','duplicate','boundary','conflict','expired')){
 $r=New-Case;$null=Activate $r;$e=$script:UnknownSessionGrids[0]
 switch($change){
 'token'{$e.record.token='foreign'} 'probe'{$e.record.records[0].path='foreign'} 'baseline'{$e.record.success.baseline.icons=@(@{identity='foreign';x=20;y=2})} 'recordsnapshot'{$e.record.snapshot.explorerPid=99} 'sample'{$e.record.success.samples[0].id=7}
 'flags'{$script:fresh.folderFlags=0;$script:fresh.snap=$false} 'pid'{$script:fresh.explorerPid++} 'birth'{$script:fresh.explorerStarted='456'} 'hwnd'{$script:fresh.listviewHwnd++} 'scale'{$script:fresh.areas[0].scale=100} 'spacing'{$script:fresh.sy++} 'offgrid'{$script:fresh.icons[0].x++} 'duplicate'{$script:fresh.icons+= $script:fresh.icons[0]} 'boundary'{$script:fresh.icons[0].x=1828} 'conflict'{$script:fresh.areas[0].grid=@{sx=114;sy=161;gx=20;gy=2}} 'expired'{$e.expires=[DateTime]::UtcNow.AddSeconds(-1)}
 }
 $null=Apply-UnknownSessionGrids $script:fresh;Check ($script:UnknownSessionGrids.Count -eq 0) ('invalidated '+$change)
}
foreach($change in @('wrongtoken','oldicons','geometry','active','dead','expiry')){
 $r=New-Case;$id=Unknown-ProvisionSessionGrid $r;$token=$r.token
 switch($change){'wrongtoken'{$token='foreign'}'oldicons'{$script:fresh.icons[0].x+=113}'geometry'{$script:fresh.explorerPid++}'active'{$script:SnapLease=@{token='different'}}'dead'{$script:dead=$true}'expiry'{$script:UnknownSessionCandidates[$id].expires=[DateTime]::UtcNow.AddSeconds(-1)}}
 $failed=$false;try{$null=Unknown-CommitSessionGrid @{token=$token;candidateId=$id}}catch{$failed=$true};Check ($failed -and $script:UnknownSessionGrids.Count -eq 0) ('commit blocked '+$change)
}
$r=New-Case;$id=Activate $r;$script:UnknownSessionGrids=@{};$script:UnknownSessionCandidates=@{};Check ($null -eq (Apply-UnknownSessionGrids $script:fresh).areas[0].grid) 'restart loses proof'
$r=New-Case;$adopted=$r|ConvertTo-Json -Depth 24|ConvertFrom-Json;$failed=$false;try{$null=Unknown-ProvisionSessionGrid $adopted}catch{$failed=$true};Check $failed 'adopt cannot mint native provenance'
$r=New-Case;$script:UnknownNativeLedgerOrigins=@{};$failed=$false;try{$null=Unknown-ProvisionSessionGrid $r}catch{$failed=$true};Check $failed 'restart cannot mint provenance'
$r=New-Case;$r.success.samples[0].id=1;$failed=$false;try{$null=Unknown-ProvisionSessionGrid $r}catch{$failed=$true};Check $failed 'native sample changes rejected'
# Execute the real read-only dispatch branch only, with the existing snapshot mock.
$leaseText=Get-Content -Raw (Join-Path $PSScriptRoot '..\scripts\unknown-grid-lease.ps1')
# Literal selection avoids interpolation of the request variable.
$line=@($leaseText -split "`n"|Where-Object{$_.Contains("'leaseUnknownSessionSnapshot'")})
if($line.Count -ne 1){throw 'session snapshot branch drift'}
$dispatch=[scriptblock]::Create('param($req)'+"`n"+$line[0])
$r=New-Case;$null=Activate $r
$response=& $dispatch @{cmd='leaseUnknownSessionSnapshot'};Check ($response.ok -and $response.sessionCalibrationCount -eq 1) 'read diagnostic active count'
$script:UnknownSessionGrids=@{};$response=& $dispatch @{cmd='leaseUnknownSessionSnapshot'};Check ($response.sessionCalibrationCount -eq 0) 'new helper diagnostic zero even inferable grid'
"unknown session cache policy: $script:n PASS; mocked IO; native Desktop not called"
