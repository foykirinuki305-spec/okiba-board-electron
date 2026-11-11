'use strict';
// CI fixture copy instrumentation only. No production source mutations.
const fs=require('fs'),path=require('path');
function instrumentResident(source,trace){
 let s=source;
 function patch(a,b){if(s.split(a).length!==2)throw Error('resident diagnostic anchor drift '+a);s=s.replace(a,b);}
 patch(' $initial=Lease-Snapshot;Resident-Validate $r $initial;'," Resident-CITrace 'rollback-start';$initial=Lease-Snapshot;Resident-Validate $r $initial;");
 patch('  $null=Lease-Guard $r (Lease-Snapshot);$n=Resident-Locate $i',"  $null=Lease-Guard $r (Lease-Snapshot);$n=Resident-Locate $i;Resident-CITrace 'before-restore' @{source=$i.source;destination=$i.destination;state=$n.state;identity=$n.record.identity;attributes=$n.record.attributes}");
 const marker="  else{$null=[OkibaResidentFiles]::RestoreUnmoved($i.source,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID)}";
 patch(marker,marker+"\n  Resident-CITrace 'after-restore' @{source=$i.source;destination=$i.destination;restoreReturned=$true}");
 patch('  $selected=Lease-Guard $r $s',"  $selected=Lease-Guard $r $s\n  $owned=@();foreach($record in $r.records){$key=Lease-Path $record.path;if($selected.ContainsKey($key)){$owned+=@{path=$record.path;icon=$selected[$key]}}};Resident-CITrace 'visibility' @{flags=$s.folderFlags;expectedFlags=$expectedFlags;stable=$stable;remaining=$owned}");
 patch('   $stable=0;$failures++',"   $stable=0;$failures++;Resident-CITrace 'disappearance-read-error' @{attempt=$attempt;failures=$failures;detail=$_.Exception.Message;failure=$_.Exception.Data['snapshotFailure']}");
 patch(' Lease-MarkRestored $r;return'," Resident-CITrace 'rollback-verified';Lease-MarkRestored $r;return");
 return s+`\nfunction Resident-CITrace([string]$phase,$detail=$null){
 if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'}
 $line=@{utc=[DateTime]::UtcNow.ToString('o');phase=$phase;detail=$detail}|ConvertTo-Json -Compress -Depth 8
 Add-Content -LiteralPath '${trace.replace(/'/g,"''")}' -Value $line -Encoding UTF8
}
`;
}
function diagnosticCopy(helperPath,caseDirectory){
 const dest=path.join(caseDirectory,'diagnostic-helper');if(fs.existsSync(dest))throw Error('diagnostic destination exists');
 fs.mkdirSync(dest);for(const f of fs.readdirSync(path.dirname(helperPath))){if(/\.(ps1|cs)$/.test(f))fs.copyFileSync(path.join(path.dirname(helperPath),f),path.join(dest,f));}
 const resident=path.join(dest,'resident-lease.ps1');fs.writeFileSync(resident,instrumentResident(fs.readFileSync(resident,'utf8'),path.join(caseDirectory,'resident-rollback-trace.jsonl')));
 return path.join(dest,path.basename(helperPath));
}
module.exports={diagnosticCopy,instrumentResident};
