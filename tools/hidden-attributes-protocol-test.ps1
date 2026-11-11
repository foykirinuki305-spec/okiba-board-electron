$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('OkibaHiddenProtocol-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
$helper=(Resolve-Path (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1')).Path
$psi=New-Object Diagnostics.ProcessStartInfo
$psi.FileName='powershell.exe';$psi.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$helper+'"'
$psi.EnvironmentVariables['OKIBA_SNAP_LEASE']='1'
$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
$process=New-Object Diagnostics.Process;$process.StartInfo=$psi
$n=0;$id=0
function Assert([bool]$condition,[string]$name){if(-not $condition){throw $name};$script:n++;Write-Host ('ok - '+$name)}
function Read-Line {
 $task=$process.StandardOutput.ReadLineAsync()
 if(-not $task.Wait(15000)){throw 'helper protocol timeout'}
 if($null -eq $task.Result){throw ('helper closed: '+$process.StandardError.ReadToEnd())}
 return ($task.Result|ConvertFrom-Json)
}
function Request($cmd,$argsObject){
 $script:id++;$argsObject.cmd=$cmd;$argsObject.id=$id
 $json=$argsObject|ConvertTo-Json -Compress
 $ascii=[regex]::Replace($json,'[^\x00-\x7F]',{param($m) '\u{0:x4}' -f [int][char]$m.Value})
 $process.StandardInput.WriteLine($ascii);$process.StandardInput.Flush();$r=Read-Line
 if($r.id -ne $id -or $null -eq $r.result){throw ('bad response: '+($r|ConvertTo-Json -Compress))}
 return $r.result
}
try {
 [void]$process.Start();$ready=Read-Line;Assert $ready.ready 'helper ready'
 $owner=Request 'leaseOwnerPin' @{pid=$PID;started=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString())};Assert ($owner.ok -and $owner.state -eq 'alive') 'dedicated lease owner pinned read-only'
 $owner=Request 'leaseOwnerState' @{};Assert ($owner.ok -and $owner.state -eq 'alive') 'dedicated owner read-only state'
 $jp=([string][char]0x65e5)+[char]0x672c+[char]0x8a9e+' space.txt'
 foreach($name in @('normal.txt',$jp,'readonly.txt','folder')){
  $p=Join-Path $root $name
  if($name -eq 'folder'){New-Item -ItemType Directory -Path $p|Out-Null}else{[IO.File]::WriteAllText($p,'kept bytes')}
  if($name -eq 'readonly.txt'){[IO.File]::SetAttributes($p,[IO.FileAttributes]::ReadOnly)}
  $mtime=[IO.File]::GetLastWriteTimeUtc($p)
  $a=Request 'readHiddenFile' @{path=$p};Assert ($a.ok -and -not $a.hidden) 'read hidden state'
  $b=Request 'setHiddenFile' @{path=$p;expectedIdentity=$a.identity;expectedHidden=$false;hidden=$true};Assert ($b.ok -and $b.hidden -and $b.identity -eq $a.identity) 'set hidden exact identity'
  $c=Request 'setHiddenFile' @{path=$p;expectedIdentity=$b.identity;expectedHidden=$true;hidden=$false};Assert ($c.ok -and -not $c.hidden -and (($c.attributes -bxor $a.attributes) -band (-bnot 130)) -eq 0) 'clear hidden preserving attributes'
  Assert ([IO.File]::GetLastWriteTimeUtc($p) -eq $mtime) 'mtime unchanged'
  if($name -ne 'folder'){Assert ([IO.File]::ReadAllText($p) -ceq 'kept bytes') 'contents unchanged'}
 }
 $records=Request 'leaseReadFiles' @{paths=@((Join-Path $root 'normal.txt'),(Join-Path $root $jp))};Assert ($records.ok -and $records.records.Count -eq 2 -and $records.records[0].identity -and $records.records[0].size -and $records.records[0].mtime) 'dedicated lease native metadata read'
 $p=Join-Path $root 'normal.txt';$a=Request 'readHiddenFile' @{path=$p}
 [IO.File]::Move($p,(Join-Path $root 'moved-original.txt'));[IO.File]::WriteAllText($p,'replacement')
 $r=Request 'setHiddenFile' @{path=$p;expectedIdentity=$a.identity;expectedHidden=$false;hidden=$true}
 Assert (-not $r.ok -and $r.detail -eq 'file-identity-changed') 'replacement identity rejected'
 Assert (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::Hidden) -eq 0) 'replacement unmodified'
 $a=Request 'readHiddenFile' @{path=$p}
 $r=Request 'setHiddenFile' @{path=$p;expectedIdentity=$a.identity;expectedHidden=$true;hidden=$false};Assert (-not $r.ok -and $r.detail -eq 'hidden-state-changed') 'stale hidden state rejected'
 $r=Request 'setHiddenFile' @{path=$p;expectedIdentity=$a.identity;hidden=$true};Assert (-not $r.ok -and $r.reason -eq 'invalid-attribute-contract') 'missing expectedHidden rejected'
 $r=Request 'setHiddenFile' @{path=$p;expectedIdentity=$a.identity;expectedHidden=$false;hidden='true'};Assert (-not $r.ok -and $r.reason -eq 'invalid-attribute-contract') 'nonboolean hidden rejected'
 $r=Request 'readHiddenFile' @{path=(Join-Path $root 'missing.txt')};Assert (-not $r.ok) 'missing file failure returned'
 $lock=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{$r=Request 'setHiddenFile' @{path=$p;expectedIdentity=$a.identity;expectedHidden=$false;hidden=$true};Assert (-not $r.ok -and $r.errorCode -eq 32) 'sharing violation code returned'}finally{$lock.Dispose()}
 $junction=Join-Path $root 'junction';New-Item -ItemType Junction -Path $junction -Target (Join-Path $root 'folder')|Out-Null
 $r=Request 'readHiddenFile' @{path=$junction};Assert (-not $r.ok -and $r.detail -eq 'reparse-path') 'junction rejected'
 Write-Host ('hidden protocol: '+$n+' checks passed; temp only; actual Windows PowerShell helper')
}finally {
 if($process.Id){$process.StandardInput.Close();if(-not $process.WaitForExit(5000)){$process.Kill();$process.WaitForExit()};$process.Dispose()}
 if($junction -and (Test-Path -LiteralPath $junction)){[IO.Directory]::Delete($junction)}
 Get-ChildItem -LiteralPath $root -File -Force|ForEach-Object {[IO.File]::SetAttributes($_.FullName,[IO.FileAttributes]::Normal)}
 Remove-Item -LiteralPath $root -Recurse -Force
}
