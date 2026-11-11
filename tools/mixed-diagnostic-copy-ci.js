// CI-copy-only observability. No retry, setting, attribute or positioning changes.
'use strict';
const assert=require('assert/strict');
function once(s,a,b){assert.equal(s.split(a).length-1,1,'diagnostic anchor must be unique');return s.replace(a,b);}
function instrumentMixed(s){
 s=s.replaceAll('\r\n','\n');
 s=once(s,'function Mixed-Trace([string]$phase,$detail=$null){} # No persistent research trace in production.',`function Mixed-Trace([string]$phase,$detail=$null){
  if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){return}
  $p=[string]$env:OKIBA_MIXED_TRACE_PATH
  if([string]::IsNullOrEmpty($p) -or -not [IO.Path]::IsPathRooted($p) -or [IO.Path]::GetFileName($p) -cne 'mixed-trace.jsonl'){return}
  try{$entry=@{time=[DateTime]::UtcNow.ToString('o');phase=$phase;detail=$detail}|ConvertTo-Json -Depth 10 -Compress;[IO.File]::AppendAllText($p,$entry+[Environment]::NewLine,(New-Object Text.UTF8Encoding($false)))}catch{}
 }`);
 s=once(s,'$stable=0;$poll=0;$previousSelected=$null','$stable=0;$poll=0;$previousSelected=$null;$lastFull=$null');
 s=once(s,'  try{$s=Lease-Snapshot}catch{',`  try{$s=Lease-Snapshot}catch{
   Mixed-Trace 'visibility-snapshot-failed' @{leasePhase=$script:LeasePhase;poll=$poll;lastFull=$lastFull;error=$_.Exception.Message;type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult}`);
 s=once(s,'  $selected=Lease-Guard $r $s',`  try{$selected=Lease-Guard $r $s}catch{
   Mixed-Trace 'visibility-guard-failed' @{leasePhase=$script:LeasePhase;poll=$poll;lastFull=$lastFull;flags=$s.folderFlags;error=$_.Exception.Message}
   throw
  }
  $lastFull=@{poll=$poll;flags=$s.folderFlags;snap=$s.snap;selectedCount=$selected.Count;oldGuardPassed=$true;oldCount=@($r.snapshot.icons).Count;iconCount=@($s.icons).Count}
  Mixed-Trace 'visibility-full-guard-passed' $lastFull`);
 return s;
}
module.exports={instrumentMixed};
