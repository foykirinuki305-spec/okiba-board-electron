$ErrorActionPreference='Stop'
$evidence=@()
try {
 foreach($x in (ConvertFrom-Json $env:OKIBA_CHILDREN)) {
  if([int]$x.pid -le 0 -or [string]$x.started -notmatch '^\d+$'){throw 'Invalid owned process identity'}
  $p=$null
  try {
   try {$p=[Diagnostics.Process]::GetProcessById([int]$x.pid)}
   catch [ArgumentException] {$evidence+=@{pid=$x.pid;expectedBirth=$x.started;state='already-exited';stopConfirmed=$true};continue}
   $null=$p.Handle
   if($p.HasExited){$evidence+=@{pid=$x.pid;expectedBirth=$x.started;state='exited-after-open';stopConfirmed=$true};continue}
   $birth=$p.StartTime.ToUniversalTime().Ticks.ToString()
   if($birth -cne [string]$x.started){$evidence+=@{pid=$x.pid;expectedBirth=$x.started;observedBirth=$birth;state='pid-reused-old-exited';stopConfirmed=$true};continue}
   if(-not $p.WaitForExit(15000)){throw 'Owned process still alive after bounded wait'}
   $evidence+=@{pid=$x.pid;expectedBirth=$x.started;observedBirth=$birth;state='matching-process-exited';stopConfirmed=$true}
  } finally {if($null -ne $p){$p.Dispose()}}
 }
 @{ok=$true;processes=@($evidence)}|ConvertTo-Json -Depth 6 -Compress
 exit 0
} catch {
 $e=$_.Exception;while($null -ne $e.InnerException){$e=$e.InnerException}
 @{ok=$false;processes=@($evidence);error=$e.Message;errorType=$e.GetType().FullName;hresult=$e.HResult;detail=[string]$_}|ConvertTo-Json -Depth 6 -Compress
 exit 1
}
