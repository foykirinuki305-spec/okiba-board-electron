$ErrorActionPreference='Stop'
# Pure candidate only: no desktop APIs, no production helper changes.
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$match=[regex]::Match($source,"(?s)Add-Type -TypeDefinition @'\r?\n(using System;\r?\nusing System.Text;.*?public static class OkibaSnapshotKey.*?)(?:\r?\n)'@")
if(-not $match.Success){throw 'production-key-class-not-found'}
Add-Type -TypeDefinition $match.Groups[1].Value
$a=$source.IndexOf('function Strict-IconsKey(');$b=$source.IndexOf('function Get-StrictDesktopSnapshotCore',$a)
Invoke-Expression $source.Substring($a,$b-$a)

function Old-Key($icons){return (@($icons|ForEach-Object {if([string]::IsNullOrEmpty([string]$_.identity)){throw 'missing-icon-identity'};(@([string]$_.identity,[int]$_.x,[int]$_.y)|ConvertTo-Json -Compress)}|Sort-Object)|ConvertTo-Json -Compress)}
function New-Key($icons){return Strict-IconsKey @{icons=@($icons)}}

$n=0;function Check($v,$m){if(-not $v){throw $m};$script:n++}
$a=@(@{identity='a';x=1;y=2},@{identity='b';x=-1;y=0});$b=@($a[1],$a[0])
Check ((New-Key $a) -ceq (New-Key $b)) 'order-independent'
Check ((New-Key @()) -ceq (New-Key @())) 'empty'
foreach($c in @(@(@{identity='a';x=2;y=2},$a[1]),@(@{identity='a';x=1;y=3},$a[1]),@(@{identity='A';x=1;y=2},$a[1]),@($a[0]))){Check ((New-Key $a) -cne (New-Key $c)) 'changes detected'}
$odd=@(@{identity="a:`n`"日本語";x=[int]::MinValue;y=[int]::MaxValue},@{identity='1:a:2:3';x=0;y=-3})
Check ((New-Key $odd) -ceq (New-Key @($odd[1],$odd[0]))) 'delimiter/unicode independent'
$threw=$false;try{New-Key @(@{identity='';x=0;y=0})|Out-Null}catch{$threw=$true};Check $threw 'missing refused'
foreach($bad in @(@($a[0],$a[0]),@(@{identity='same';x=1;y=2},@{identity='same';x=3;y=4}))){$threw=$false;try{New-Key $bad|Out-Null}catch{$threw=$true};Check $threw 'duplicate identity rejected'}
$threw=$false;try{New-Key @(@{identity='bounds';x=2147483648;y=0})|Out-Null}catch{$threw=$true};Check $threw 'out-of-int-range refused'
Check ((New-Key @(@{identity='a';x=1;y=2},@{identity='A';x=1;y=2})).Length -gt 0) 'ordinal case distinct'
Check ((New-Key @(@{identity='1:a';x=2;y=3})) -cne (New-Key @(@{identity='a';x=12;y=3}))) 'length collision resisted'
$r=[Random]::new(17)
for($trial=0;$trial -lt 100;$trial++){
 $icons=@(for($i=0;$i -lt 50;$i++){@{identity=('id{0:D4}' -f $i);x=$r.Next(-2000,4000);y=$r.Next(-1000,2000)}})
 $copy=@($icons|Sort-Object -Property x,y)
 Check (((Old-Key $icons) -ceq (Old-Key $copy)) -eq ((New-Key $icons) -ceq (New-Key $copy))) 'equivalent equality'
 $copy=@($copy);$z=$copy[0];$copy[0]=@{identity=$z.identity;x=$z.x+1;y=$z.y}
 Check (((Old-Key $icons) -ceq (Old-Key $copy)) -eq ((New-Key $icons) -ceq (New-Key $copy))) 'equivalent changed equality'
}
foreach($size in @(202,1000)){
 $icons=@(for($i=0;$i -lt $size;$i++){@{identity=('ABCD{0:D8}0123456789abcdef' -f $i);x=$i%20*101;y=[int]($i/20)*67}})
 Old-Key $icons|Out-Null;New-Key $icons|Out-Null
 $old=@();$new=@();for($j=0;$j -lt 7;$j++){$w=[Diagnostics.Stopwatch]::StartNew();Old-Key $icons|Out-Null;$old+=$w.Elapsed.TotalMilliseconds;$w.Restart();New-Key $icons|Out-Null;$new+=$w.Elapsed.TotalMilliseconds}
 Write-Host ('icons={0} oldMedianMs={1:N2} newMedianMs={2:N2}' -f $size,(@($old|Sort-Object)[3]),(@($new|Sort-Object)[3]))
}
Write-Host "icon-key production: $n pure checks passed; no desktop calls"
