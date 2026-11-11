'use strict';
// CI fixture copy instrumentation only. No production source mutations.
const fs=require('fs'),path=require('path');
function instrumentResident(source,trace){
 let s=source;
 function patch(a,b){if(s.split(a).length!==2)throw Error('resident diagnostic anchor drift '+a);s=s.replace(a,b);}
 const start=s.indexOf('function Resident-Rollback('),end=s.indexOf('function Resident-ReleaseSources(',start);if(start<0||end<0)throw Error('rollback boundaries');
 let body=s.slice(start,end);s=s.slice(0,start)+'__ROLLBACK__'+s.slice(end);
 body=body.replace(' Resident-Validate $r (Lease-Snapshot)'," Resident-CITrace 'rollback-start';Resident-Validate $r (Lease-Snapshot)");
 body=body.replace('$n=Resident-Locate $i',"$n=Resident-Locate $i;Resident-CITrace 'before-restore' @{source=$i.source;destination=$i.destination;state=$n.state;identity=$n.record.identity;attributes=$n.record.attributes}");
 const marker="  else{$null=[OkibaResidentFiles]::RestoreUnmoved($i.source,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID)}";
 if(body.split(marker).length!==2)throw Error('restore anchor');
 body=body.replace(marker,marker+"\n  $proof=Resident-Locate $i;Resident-CITrace 'after-restore' @{source=$i.source;destination=$i.destination;state=$proof.state;identity=$proof.record.identity;attributes=$proof.record.attributes}");
 body=body.replace("$s=Lease-WaitVisibility $r $false","$s=Resident-CIWaitVisibility $r $false");
 body=body.replace("Lease-MarkRestored $r;return", "Resident-CITrace 'rollback-verified';Lease-MarkRestored $r;return");
 patch('__ROLLBACK__',body);
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
 const snap=fs.readFileSync(path.join(dest,'snap-lease.ps1'),'utf8');const a=snap.indexOf('function Lease-WaitVisibility('),b=snap.indexOf('function Lease-AssertFastOff(',a);if(a<0||b<a)throw Error('visibility bounds');
 let wait=snap.slice(a,b).replace('function Lease-WaitVisibility(','function Resident-CIWaitVisibility(');
 const anchor='  $s=Lease-Snapshot;$selected=Lease-Guard $r $s';if(wait.split(anchor).length!==2)throw Error('wait anchor');
 wait=wait.replace(anchor,anchor+`\n  $owned=@();foreach($record in $r.records){$key=Lease-Path $record.path;if($selected.ContainsKey($key)){$owned+=@{path=$record.path;icon=$selected[$key]}}};Resident-CITrace 'visibility' @{flags=$s.folderFlags;visible=$visible;stable=$stable;remaining=$owned}`);
 fs.appendFileSync(resident,'\n'+wait);return path.join(dest,path.basename(helperPath));
}
module.exports={diagnosticCopy,instrumentResident};
