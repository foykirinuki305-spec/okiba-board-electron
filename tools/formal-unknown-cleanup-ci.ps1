param([ValidateSet('environment','processes','hide')][string]$Action)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'hosted Windows only'}
# Explicit own-record cleanup only, after caller has proved terminal + all children stopped.
if($env:OKIBA_PREVIEW_TERMINAL -cne 'confirmed'){throw 'terminal proof required'}
# BEGIN tested-preview-record-parser
function Read-PreviewRecords([string]$json){
 $parsed=ConvertFrom-Json $json
 if($parsed -isnot [array] -or $parsed.Count -ne 3){throw 'three owned records required'}
 foreach($record in $parsed){if($record -isnot [pscustomobject] -or $record.path -isnot [string]){throw 'invalid owned record'}}
 return $parsed
}
# END tested-preview-record-parser
$records=Read-PreviewRecords $env:OKIBA_PREVIEW_RECORDS
$desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory'))
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
foreach($block in [regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")){Add-Type -TypeDefinition $block.Groups[1].Value}
foreach($r in $records){$p=[IO.Path]::GetFullPath([string]$r.path);if([IO.Path]::GetDirectoryName($p) -cne $desktop -or [IO.Path]::GetFileName($p) -notmatch '^OkibaUnknown-[a-f0-9]{12}\.txt$'){throw 'not own desktop file'};$n=[OkibaFileAttributes]::Read($p);if($n.identity -cne $r.identity -or $n.size -cne $r.size -or $n.mtime -cne $r.mtime -or $n.hidden -or $n.attributes -ne 32){throw 'cleanup identity/metadata changed'}}
foreach($r in $records){$null=[OkibaFileAttributes]::SetRecordedAndNotify($r.path,$r.identity,$false,$true,$r.size,$r.mtime,[uint32]32)}
@{ok=$true}|ConvertTo-Json -Compress
