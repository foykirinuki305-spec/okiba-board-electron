$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1'
# Compiles embedded types only; never runs helper script/session/native COM methods.
& (Join-Path $PSScriptRoot 'check-ps.ps1') -File $source
$type='OkibaFolderView' -as [type]
$m=$type.GetMethod('ValidateExactLeaseFlags',[Reflection.BindingFlags]'NonPublic,Static')
if($null -eq $m){throw 'missing exact flag pure predicate'}
$n=0
foreach($case in @(@(0,0,1,$true),@(4,4,1,$true),@(1075839520,1075839520,1,$true),@(1075839524,1075839524,1,$true),@(0,4,1,$false),@(4,0,1,$false),@(1,1,1,$false),@(5,5,1,$false),@(4,4,0,$false),@(0,0,0,$false),@(4,4,-1,$false),@(4,4,2,$false),@(12,4,1,$false))){
 $ok=$true;try{$null=$m.Invoke($null,[object[]]@([uint32]$case[0],[uint32]$case[1],[int]$case[2]))}catch{$ok=$false}
 if($ok -ne $case[3]){throw ('wrong flags result '+($case -join ','))};$n++
}
$s=Get-Content -Raw $source
if($s -notmatch [regex]::Escape('if(flags!=expectedFlags||(flags&5)!=0||s.Folder.GetAutoArrange()!=1)')){throw 'OFF guard changed'}
$exact=[regex]::Match($s,'(?s)public static void AssertLeaseExactSessionFlags\(.*?\n }').Value
foreach($need in @('AssertLeaseSession(s,expectedLv,expectedPid,expectedStarted)','GetCurrentFolderFlags(out flags)','ValidateExactLeaseFlags(flags,expectedFlags,s.Folder.GetAutoArrange())')){if(-not $exact.Contains($need)){throw ('exact guard missing '+$need)}}
$resident=Get-Content -Raw (Join-Path $PSScriptRoot '..\scripts\resident-lease.ps1')
if($resident.Contains('Lease-AssertFastOff $r $expectedFlags')){throw 'rollback still uses OFF-only witness'}
"resident exact flags: $n cases PASS; full C# compile; no native calls"
