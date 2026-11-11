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
