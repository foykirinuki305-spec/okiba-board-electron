$ErrorActionPreference='Stop'
# Extract only the pure all-grid predicate. Never dot-source native helper/runtime.
$source=Join-Path $PSScriptRoot '..\scripts\snap-lease.ps1';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $source),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failure'}
$fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Lease-AllGrid'},$true))
if($fn.Count -ne 1){throw 'predicate drift'};. ([scriptblock]::Create($fn[0].Extent.Text))
function Snapshot {
 $icons=@();for($n=0;$n -lt 202;$n++){$icons+=@{identity="old-$n";x=(-1857+78*($n%23));y=(2+98*[Math]::Floor($n/23))}}
 return @{areas=@(@{left=-1920;top=0;right=0;bottom=1080;grid=@{sx=78;sy=98;gx=15;gy=2}},@{left=0;top=0;right=1920;bottom=1080;grid=$null});icons=$icons}
}
$s=Snapshot;Lease-AllGrid $s $s
$s=Snapshot;$s.icons+=@{identity='existing-on-unknown';x=20;y=2};$failed=$false;try{Lease-AllGrid $s $s}catch{$failed=$true};if(-not $failed){throw 'unknown nonempty incorrectly accepted'}
$s.areas[1].grid=@{sx=113;sy=161;gx=20;gy=2};Lease-AllGrid $s $s
$s.icons[-1].x++;$failed=$false;try{Lease-AllGrid $s $s}catch{$failed=$true};if(-not $failed){throw 'offgrid old incorrectly accepted'}
$s=Snapshot;$s.icons[100].x++;$failed=$false;try{Lease-AllGrid $s $s}catch{$failed=$true};if(-not $failed){throw 'known old offgrid incorrectly accepted'}
$s=Snapshot;$s.areas[0].grid=$null;$failed=$false;try{Lease-AllGrid $s $s}catch{$failed=$true};if(-not $failed){throw 'other monitor unknown accepted'}
'unknown mixed environment pure all-grid: 6 PASS (202 synthetic icons, no Desktop)'
