$ErrorActionPreference='Stop'
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}
$blocks=[regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
foreach($b in $blocks){Add-Type -TypeDefinition $b.Groups[1].Value}
if(-not [OkibaFolderView]::VerifyEmptyCounts(0,0,0,0)){throw 'empty'}
if([OkibaFolderView]::VerifyEmptyCounts(0,1,0,0)){throw 'nonempty'}
$cases=@(@(0,0,0,1),@(0,0,0,-1),@(1,0,0,0),@(-2147023728,0,0,0),@(0,0,1,0),@(0,0,-2147023728,0),@(0,-1,0,0))
foreach($c in $cases){$threw=$false;try{[void][OkibaFolderView]::VerifyEmptyCounts($c[0],$c[1],$c[2],$c[3])}catch{$threw=$true};if(-not $threw){throw ('must reject '+($c -join ','))}}
# The empty shortcut supplies no PIDL; identity lookup keeps its existing missing error.
if(-not $source.Contains('throw new InvalidOperationException("shell-item-identity-missing")')){throw 'identity missing rejection removed'}
Write-Host ('empty count proof 9 checks PASS; '+$blocks.Count+' C# blocks compiled; no Desktop API invoked')
$script:proofReads=0
$script:proofAnswers=@(@(0,0),@(0,0))
$reader=[Func[int[]]]{ $v=$script:proofAnswers[$script:proofReads];$script:proofReads++;return [int[]]$v }
if([OkibaFolderView]::ResolveEmptyItems(0,[IntPtr]1,$reader)){throw 'success became empty'}
if($script:proofReads -ne 0){throw 'success queried counts'}
if(-not [OkibaFolderView]::ResolveEmptyItems(-2147023728,[IntPtr]::Zero,$reader)){throw 'proven empty rejected'}
if($script:proofReads -ne 2){throw 'two counts required'}
$failures=@(
 @{hr=-2147023728;ptr=0;answers=@(@(0,1));reads=1},
 @{hr=-2147023728;ptr=0;answers=@(@(0,0),@(0,1));reads=2},
 @{hr=-2147023728;ptr=0;answers=@(@(1,0));reads=1},
 @{hr=-2147023728;ptr=0;answers=@(@(0,0),@(-2147024891,0));reads=2},
 @{hr=-2147023728;ptr=1;answers=@();reads=0},
 @{hr=-2147024891;ptr=0;answers=@();reads=0},
 @{hr=1;ptr=0;answers=@();reads=0},
 @{hr=0;ptr=0;answers=@();reads=0}
)
foreach($f in $failures){
 $script:proofReads=0;$script:proofAnswers=$f.answers;$caught=$null
 try{[void][OkibaFolderView]::ResolveEmptyItems($f.hr,[IntPtr]$f.ptr,$reader)}catch{$caught=$_.Exception;while($caught.InnerException){$caught=$caught.InnerException}}
 if($null -eq $caught){throw 'unproven empty accepted'}
 if($f.hr -lt 0 -and $caught.HResult -ne $f.hr){throw 'original HRESULT lost'}
 if($script:proofReads -ne $f.reads){throw 'unexpected count calls'}
}
$script:proofReads=0
$broken=[Func[int[]]]{ $script:proofReads++;throw 'read-failed' }
$caught=$null;try{[void][OkibaFolderView]::ResolveEmptyItems(-2147023728,[IntPtr]::Zero,$broken)}catch{$caught=$_.Exception;while($caught.InnerException){$caught=$caught.InnerException}}
if($null -eq $caught -or $caught.HResult -ne -2147023728 -or $script:proofReads -ne 1){throw 'count exception replaced original error'}
Write-Host 'Items fast path and error-preserving empty proof: 11 branch checks PASS; no Desktop API invoked'
