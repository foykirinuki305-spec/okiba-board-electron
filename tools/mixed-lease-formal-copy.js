'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {ownedCopyDestination}=require('./mixed-lease-copy-builder'),{generateMixedDriver}=require('./mixed-lease-driver-builder');
const root=path.resolve(__dirname,'..');
function buildFormalMixedCopy(destination){
 destination=ownedCopyDestination(destination);fs.mkdirSync(destination);
 for(const name of ['lib','scripts'])fs.cpSync(path.join(root,name),path.join(destination,name),{recursive:true});fs.mkdirSync(path.join(destination,'tools'));
 // The sole helper patch is an OWNED FIXTURE setup command, not mixed dispatch.
 const helper=path.join(destination,'scripts/shell-helper.ps1'),anchor="      'readHiddenFile'       { $result = Invoke-HiddenFileRequest $req $false }";let s=fs.readFileSync(helper,'utf8');if(s.split(anchor).length!==2)throw Error('fixture command anchor');
 s=s.replace(anchor,`      'ciMixedHideOwned' {
       if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'}
       $p=[IO.Path]::GetFullPath([string]$req.path)
       if([IO.Path]::GetDirectoryName($p) -ine [Environment]::GetFolderPath('DesktopDirectory') -or [IO.Path]::GetFileName($p) -notmatch '^OkibaResident-[a-f0-9]{16}-'){throw 'owned fixture only'}
       $n=[OkibaFileAttributes]::SetRecordedAndNotify($p,[string]$req.expectedIdentity,[bool]$req.expectedHidden,$true,[string]$req.size,[string]$req.mtime,[uint32]$req.attributes)
       $result=@{ok=$true;hidden=$n.hidden;identity=$n.identity}
      }
`+anchor);fs.writeFileSync(helper,s);
 let host=fs.readFileSync(path.join(root,'tools/desktop-lease-protocol-host-ci.js'),'utf8').replace('hidden:true})),snapshot:spec.baseline','hidden:true,mode:i.mode})),snapshot:spec.baseline');if(!host.includes('mode:i.mode'))throw Error('host fixture mode');host=host.replaceAll('createDesktopLeaseClient({','createDesktopLeaseClient({allowMixed:true,').replaceAll('runLease({','runLease({allowMixed:true,');fs.writeFileSync(path.join(destination,'tools/desktop-lease-protocol-host-ci.js'),host);
 generateMixedDriver(destination,path.join(root,'tools/resident-lease-ci.js'));
 const driver=path.join(destination,'tools/mixed-driver-ci.js');s=fs.readFileSync(driver,'utf8').replaceAll('mixed-hidden-resident-prototype','mixed-hidden-resident').replaceAll('mixed-lease-native-ci.ps1','mixed-lease.ps1').replaceAll('mixed-rename-notify-ci.cs','mixed-rename-notify.cs');
 if(!s.includes(",'show-hidden-mid-stage'"))throw Error('case list');s=s.replace(",'show-hidden-mid-stage'",'');s=s.replaceAll('createDesktopLeaseClient({','createDesktopLeaseClient({allowMixed:true,').replaceAll('runLease({','runLease({allowMixed:true,');fs.writeFileSync(driver,s);
 const sameFiles=['lib/desktop-snap-lease-controller.js','lib/desktop-lease-watchdog.js','scripts/snap-lease.ps1','scripts/mixed-lease.ps1','scripts/resident-lease.ps1','scripts/mixed-rename-notify.cs'];
 const hashes={};for(const file of sameFiles){const a=fs.readFileSync(path.join(root,file)),b=fs.readFileSync(path.join(destination,file));if(!a.equals(b))throw Error('runtime was patched '+file);hashes[file]=crypto.createHash('sha256').update(a).digest('hex');}
 // Prove original parity first, then label the sole observability-only private patch.
 const diagnosticFile=path.join(destination,'scripts/mixed-lease.ps1');
 fs.writeFileSync(diagnosticFile,require('./mixed-diagnostic-copy-ci').instrumentMixed(fs.readFileSync(diagnosticFile,'utf8')));
 const diagnostics={file:'scripts/mixed-lease.ps1',purpose:'CI-only trace; no retry or mutation changes',patchedSha256:crypto.createHash('sha256').update(fs.readFileSync(diagnosticFile)).digest('hex')};
 fs.writeFileSync(path.join(destination,'copy-manifest.json'),JSON.stringify({formalRuntime:true,mainEnabled:false,helperFixtureCommandOnly:true,hashes,diagnostics},null,2));return destination;
}
module.exports={buildFormalMixedCopy};
