# Pure benchmark. Extract ONE arithmetic production function; never load helper/native APIs.
$ErrorActionPreference='Stop'
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$referencePath=Join-Path $PSScriptRoot 'area-grid-reference.ps1'
$reference=([IO.File]::ReadAllText($referencePath)).Trim().Replace("`r`n","`n")
$expectedHash=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'area-grid-reference.sha256') -Raw).Trim()
$sha=[Security.Cryptography.SHA256]::Create();try{$actualHash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($reference)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
if($actualHash -cne $expectedHash){throw 'reference fixture hash changed'}
Invoke-Expression $reference
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$t,[ref]$e)
$f=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Set-StrictAreaGrids'},$true)
if(-not $f){throw 'production pure wrapper missing'};Invoke-Expression $f.Extent.Text
$blocks=@([regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")|Where-Object{$_.Groups[1].Value.Contains('public static class OkibaStrictAreaGrid')})
if($blocks.Count -ne 1){throw 'pure class missing/duplicate'};Add-Type -TypeDefinition $blocks[0].Groups[1].Value
function Reference($icons,$areas,[int]$sx,[int]$sy,[int]$dpi){
 $out=New-Object 'System.Collections.Generic.List[object]'
 foreach($a in $areas){$members=@($icons|Where-Object{$_.x -ge $a[0] -and $_.x -lt $a[2] -and $_.y -ge $a[1] -and $_.y -lt $a[3]});$g=Strict-InferAreaGrid $members $sx $sy $a[4] $dpi;if($null -eq $g){$out.Add($null)}else{$out.Add([int[]]@($g.gx,$g.gy,$g.sx,$g.sy))}}
 return ,$out.ToArray()
}
function Candidate($icons,$areas,[int]$sx,[int]$sy,[int]$dpi){
 # Production wrapper includes typed-array conversions and output mapping.
 $nativeAreas=New-Object 'System.Collections.Generic.List[object]'
 foreach($a in $areas){$nativeAreas.Add(@{left=$a[0];top=$a[1];right=$a[2];bottom=$a[3];scale=$a[4];grid=$null})}
 $mapped=$nativeAreas.ToArray();Set-StrictAreaGrids $icons $mapped $sx $sy $dpi
 $out=New-Object 'System.Collections.Generic.List[object]'
 foreach($a in $mapped){$g=$a.grid;if($null -eq $g){$out.Add($null)}else{$out.Add([int[]]@($g.gx,$g.gy,$g.sx,$g.sy))}}
 return ,$out.ToArray()
}
function Key($grids){return (($grids|ForEach-Object{if($null -eq $_){'null'}else{($_ -join ',')}})-join ';')}
# Production writes grid only: preserve identities, optional/future fields and object references.
$future=New-Object PSObject -Property @{value='keep'}
$unchangedIcons=@(@{x=42;y=2;identity=('A:unicode-'+[char]0x3042);path='C:\fake';future=$future})
$iconsBefore=$unchangedIcons|ConvertTo-Json -Depth 8 -Compress
$oneArea=@(@{left=0;top=0;right=1000;bottom=1000;scale=100;grid=@{old='replace'};monitorOrigin=@{x=-1920;y=71};future=$future})
$origin=$oneArea[0].monitorOrigin
Set-StrictAreaGrids $unchangedIcons $oneArea 101 67 96
if($oneArea[0].grid.gx -ne 42 -or $oneArea[0].grid.gy -ne 2 -or -not [object]::ReferenceEquals($oneArea[0].future,$future) -or -not [object]::ReferenceEquals($oneArea[0].monitorOrigin,$origin) -or ($unchangedIcons|ConvertTo-Json -Depth 8 -Compress) -cne $iconsBefore){throw 'non-grid fields mutated'}
$oneArea[0].scale=150;Set-StrictAreaGrids $unchangedIcons $oneArea 101 67 96;if($null -ne $oneArea[0].grid -or -not [object]::ReferenceEquals($oneArea[0].future,$future)){throw 'unknown grid/fields changed'}
$script:checks=2;$script:known=0
function Check($icons,$areas,[int]$sx,[int]$sy,[int]$dpi){
 $a=Reference $icons $areas $sx $sy $dpi;$b=Candidate $icons $areas $sx $sy $dpi
 if((Key $a) -cne (Key $b)){throw ('mismatch '+(@{icons=$icons;areas=$areas;sx=$sx;sy=$sy;dpi=$dpi;reference=$a;candidate=$b}|ConvertTo-Json -Depth 10 -Compress))}
 $script:checks++;foreach($g in $a){if($null -ne $g){$script:known++}}
}
$extreme=@(@{x=[int]::MinValue;y=[int]::MinValue},@{x=[int]::MaxValue-1;y=[int]::MaxValue-1},@{x=-1;y=-1},@{x=0;y=0})
$wide=@(,[int[]]@([int]::MinValue,[int]::MinValue,[int]::MaxValue,[int]::MaxValue,100))
foreach($sx in @(-1,0,1,78,[int]::MaxValue)){foreach($sy in @(0,1,98,[int]::MaxValue)){Check $extreme $wide $sx $sy 96;Check @() $wide $sx $sy 96}}
foreach($scale in @(0,-1,100,150,[int]::MaxValue)){foreach($dpi in @(0,-1,96,144,[int]::MaxValue)){Check @(@{x=-1;y=-1}) @(,[int[]]@(-10,-10,10,10,$scale)) 78 98 $dpi}}
# Boundary inclusion/exclusion; overlapping, duplicate, inverted and zero-size regions.
$regions=@([int[]]@(-100,-100,100,100,100),[int[]]@(-100,-100,100,100,100),[int[]]@(100,-100,200,100,150),[int[]]@(0,0,0,10,100),[int[]]@(10,10,-10,-10,100))
Check @(@{x=-100;y=-100},@{x=100;y=100},@{x=99;y=99}) $regions 100 100 96
$r=New-Object Random(57017)
for($case=0;$case -lt 400;$case++){
 $sx=$r.Next(1,201);$sy=$r.Next(1,201);$dpi=@(96,120,144,0)[$case%4];$areas=@();for($a=0;$a -lt 1+($case%4);$a++){$left=$r.Next(-2000,1000);$top=$r.Next(-800,800);$areas+=,([int[]]@($left,$top,($left+$r.Next(0,2500)),($top+$r.Next(0,1800)),@(100,125,150,0)[($case+$a)%4]))}
 $icons=@();for($i=0;$i -lt ($case%31);$i++){$icons+=@{x=$r.Next(-3000,3000);y=$r.Next(-1500,2000)}};Check $icons $areas $sx $sy $dpi
 # Known lattices, negatives, duplicate icons, multi-DPI regions; don't test only nulls.
 $icons=@();for($i=0;$i -lt 1+($case%20);$i++){$icons+=@{x=(-1000+($i%5)*$sx);y=(-1000+[int][Math]::Floor($i/5)*$sy)}};$icons+=@{x=-1000;y=-1000};Check $icons @([int[]]@(-1500,-1500,5000,5000,100),[int[]]@(-1500,-1500,5000,5000,150)) $sx $sy 96
}
Check @() @() 101 67 96
Check @(@{x=1;y=1}) @() 101 67 96
$shapeRejected=0
foreach($test in @({[OkibaStrictAreaGrid]::Infer($null,[int[]]@(),[int[][]]@(),1,1,96)},{[OkibaStrictAreaGrid]::Infer([int[]]@(1),[int[]]@(),[int[][]]@(),1,1,96)},{[OkibaStrictAreaGrid]::Infer([int[]]@(),[int[]]@(),[int[][]]@(,[int[]]@(1,2)),1,1,96)})){
 try{$null=& $test;throw 'invalid shape accepted'}catch{if($_.Exception.Message -eq 'invalid shape accepted'){throw};$shapeRejected++}
}
$icons=@();for($i=0;$i -lt 202;$i++){$icons+=@{x=(42+($i%17)*101);y=(2+[int][Math]::Floor($i/17)*67)}}
$areas=@([int[]]@(0,0,1920,1080,100),[int[]]@(-1920,71,0,1151,100),[int[]]@(1920,0,4480,1440,150));Check $icons $areas 101 67 96
# Warm JIT/PowerShell callsites; median of five rounds, no Shell calls.
for($i=0;$i -lt 10;$i++){$null=Reference $icons $areas 101 67 96;$null=Candidate $icons $areas 101 67 96}
$results=@();for($round=0;$round -lt 5;$round++){foreach($kind in $(if($round%2 -eq 0){@('Reference','Candidate')}else{@('Candidate','Reference')})){$sw=[Diagnostics.Stopwatch]::StartNew();for($i=0;$i -lt 40;$i++){$null=& $kind $icons $areas 101 67 96};$sw.Stop();$results+=@{kind=$kind;round=$round;perRawMs=$sw.Elapsed.TotalMilliseconds/40}}}
@{checks=$checks;malformedRejected=$shapeRejected;knownAreaResults=$known;icons=202;areas=3;conversionIncluded=$true;desktopAccess=$false;ps=$PSVersionTable.PSVersion.ToString();timings=$results}|ConvertTo-Json -Depth 5
