# CI fixture isolation only; does not change the legacy placement implementation.
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Desktop fixture guard is hosted CI only'}
if(-not ('OkibaFolderView' -as [type])){
 $src=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
 foreach($b in [regex]::Matches($src,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")){Add-Type -TypeDefinition $b.Groups[1].Value -ErrorAction Stop}
}
if(-not ('OkibaFixtureNotifyCI' -as [type])){
 Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class OkibaFixtureNotifyCI{
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)]static extern void SHChangeNotify(uint e,uint f,string p,IntPtr other);
 public static void Deleted(string p){
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("CI only");
  if(System.IO.File.Exists(p)||System.IO.Directory.Exists(p))throw new InvalidOperationException("delete notification for existing path forbidden");
  SHChangeNotify(4u,0x1005u,p,IntPtr.Zero);
 }
}
'@ -ErrorAction Stop
}
function Read-FixtureIcons {
 $dpi=[OkibaWin32]::EnterPhysicalScope()
 try{return ,@([OkibaFolderView]::ReadShellBatch('ci-fixture-guard'))}finally{if($dpi -ne [IntPtr]::Zero){[OkibaWin32]::LeavePhysicalScope($dpi)}}
}
function Fixture-Key($icons){return (@($icons|ForEach-Object{([string]$_.identity)+':'+([string]$_.x)+':'+([string]$_.y)}|Sort-Object)|ConvertTo-Json -Compress)}
function Start-FixtureGuard {
 $last=$null;$deadline=[DateTime]::UtcNow.AddSeconds(10)
 do{$next=Read-FixtureIcons;if($null -ne $last -and (Fixture-Key $last) -ceq (Fixture-Key $next)){return ,$next};$last=$next;Start-Sleep -Milliseconds 150}while([DateTime]::UtcNow -lt $deadline)
 throw 'CI fixture initial icons did not stabilize'
}
function Complete-FixtureGuard($baseline,[string[]]$owned){
 $allowed=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
 foreach($p in $owned){[void]$allowed.Add([IO.Path]::GetFullPath($p));if(Test-Path -LiteralPath $p){throw ('owned fixture still exists: '+$p)};[OkibaFixtureNotifyCI]::Deleted($p)}
 $expected=New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
 foreach($i in $baseline){if([string]::IsNullOrEmpty($i.identity)-or $expected.ContainsKey($i.identity)){throw 'invalid baseline identity'};$expected.Add($i.identity,$i)}
 $deadline=[DateTime]::UtcNow.AddSeconds(20);$consecutive=0;$current=$null
 do {
  $current=Read-FixtureIcons;$seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal);$remaining=@();$bad=@()
  foreach($i in $current){
   if(-not $seen.Add($i.identity)){$bad+=@{reason='duplicate-identity';icon=$i};continue}
   if($expected.ContainsKey($i.identity)){$old=$expected[$i.identity];if($old.x -ne $i.x -or $old.y -ne $i.y){$bad+=@{reason='existing-position-changed';before=$old;after=$i}}}
   elseif(-not [string]::IsNullOrEmpty($i.path) -and $allowed.Contains([IO.Path]::GetFullPath($i.path))){$remaining+=$i}
   else{$bad+=@{reason='unknown-extra';icon=$i}}
  }
  foreach($id in $expected.Keys){if(-not $seen.Contains($id)){$bad+=@{reason='existing-identity-missing';before=$expected[$id]}}}
  if($bad.Count){Write-Host ('FIXTURE CLEANUP EXISTING CHANGE '+(@{before=$baseline;after=$current;bad=$bad;owned=$owned}|ConvertTo-Json -Depth 12 -Compress));throw 'fixture cleanup changed a baseline icon or observed an unrelated item'}
  if($remaining.Count -eq 0){$consecutive++}else{$consecutive=0}
  if($consecutive -ge 2){Write-Host ('CI fixture cleanup verified: '+$owned.Count+' owned paths absent, '+$expected.Count+' original icons unchanged');return}
  Start-Sleep -Milliseconds 150
 }while([DateTime]::UtcNow -lt $deadline)
 Write-Host ('FIXTURE CLEANUP OWNED REMAINDER '+(@{before=$baseline;after=$current;owned=$owned}|ConvertTo-Json -Depth 12 -Compress))
 throw 'owned fixture icons remained after 20 seconds'
}
