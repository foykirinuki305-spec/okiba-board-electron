param([ValidateSet('environment','processes','hide')][string]$Action)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'hosted Windows only'}
if($Action -eq 'environment'){@{desktop=[Environment]::GetFolderPath('DesktopDirectory');localAppData=[Environment]::GetFolderPath('LocalApplicationData');sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Compress;exit}
if($Action -eq 'processes'){
 $rootPID=0;if(-not [int]::TryParse($env:OKIBA_PREVIEW_ROOT_PID,[ref]$rootPID) -or $rootPID -le 0){throw 'root PID required'}
 $all=@(Get-CimInstance Win32_Process);$ids=New-Object 'System.Collections.Generic.HashSet[int]';$null=$ids.Add($rootPID)
 do{$added=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added=$true}}}while($added)
 $result=@();foreach($c in $all){if(-not $ids.Contains([int]$c.ProcessId)){continue};$process=$null
  try{
   try{$process=[Diagnostics.Process]::GetProcessById([int]$c.ProcessId)}catch [ArgumentException]{continue}
   $null=$process.Handle;if($process.HasExited){continue};$birth=$process.StartTime.ToUniversalTime().Ticks.ToString()
   $fresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.ProcessId)
   if(-not $fresh){if($process.HasExited){continue};throw 'process disappeared without exit proof'}
   if($fresh.ParentProcessId -ne $c.ParentProcessId -or $fresh.CreationDate -ne $c.CreationDate){throw 'process ancestry/birth changed during pin'}
   if($process.HasExited){continue}
   $result+=@{pid=[int]$c.ProcessId;parent=[int]$c.ParentProcessId;started=$birth}
  }finally{if($null -ne $process){$process.Dispose()}}
 }
 if(-not @($result|Where-Object {$_.pid -eq $rootPID}).Count){throw 'root process not pinned'}
 ConvertTo-Json -InputObject @($result) -Compress;exit
}
# Explicit own-record cleanup only, after caller has proved terminal + all children stopped.
if($env:OKIBA_PREVIEW_TERMINAL -cne 'confirmed'){throw 'terminal proof required'}
# BEGIN tested-preview-record-parser
function Read-PreviewRecords([string]$json){
 $parsed=ConvertFrom-Json $json
 if($parsed -isnot [array] -or $parsed.Count -ne 6){throw 'six owned records required'}
 foreach($record in $parsed){if($record -isnot [pscustomobject] -or $record.path -isnot [string]){throw 'invalid owned record'}}
 return $parsed
}
# END tested-preview-record-parser
$records=Read-PreviewRecords $env:OKIBA_PREVIEW_RECORDS
$desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory'))
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
foreach($block in [regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")){Add-Type -TypeDefinition $block.Groups[1].Value}
foreach($r in $records){$p=[IO.Path]::GetFullPath([string]$r.path);if([IO.Path]::GetDirectoryName($p) -cne $desktop -or [IO.Path]::GetFileName($p) -notmatch '^OkibaPreview-[a-f0-9]{24}-[123456]\.txt$'){throw 'not own desktop file'};$n=[OkibaFileAttributes]::Read($p);if($n.identity -cne $r.identity -or $n.size -cne $r.size -or $n.mtime -cne $r.mtime -or $n.hidden -or $n.attributes -ne 32){throw 'cleanup identity/metadata changed'}}
foreach($r in $records){$null=[OkibaFileAttributes]::SetRecordedAndNotify($r.path,$r.identity,$false,$true,$r.size,$r.mtime,[uint32]32)}
@{ok=$true}|ConvertTo-Json -Compress
