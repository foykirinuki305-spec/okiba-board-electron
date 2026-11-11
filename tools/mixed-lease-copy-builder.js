'use strict';
// Creates a private research runtime; never edits or patches installed code.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const root=path.resolve(__dirname,'..');
function ownedCopyDestination(destination){
 if(typeof destination!=='string'||!path.isAbsolute(destination)||path.basename(destination)!=='runtime')throw Error('owned TEMP runtime destination required');
 const parent=path.dirname(path.resolve(destination)),st=fs.lstatSync(parent);
 if(!st.isDirectory()||st.isSymbolicLink())throw Error('copy parent must be a real owned directory');
 const realParent=fs.realpathSync.native(parent),realTemp=fs.realpathSync.native(os.tmpdir());
 const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 if(!equal(path.dirname(realParent),realTemp)||!/^okiba-mixed-(runtime|copy-pure)-[A-Za-z0-9]+$/.test(path.basename(realParent)))throw Error('copy outside owned canonical TEMP parent');
 const target=path.join(realParent,'runtime');try{fs.lstatSync(target);throw Error('copy destination already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 return target;
}
function buildMixedCopy(destination){
 destination=ownedCopyDestination(destination);
 fs.mkdirSync(destination);for(const name of ['lib','scripts'])fs.cpSync(path.join(root,name),path.join(destination,name),{recursive:true});
 fs.mkdirSync(path.join(destination,'tools'));
 const evidence=[];
 function patch(relative,from,to,count=1){const f=path.join(destination,relative),s=fs.readFileSync(f,'utf8');if(s.split(from).length-1!==count)throw Error('Mixed copy anchor mismatch: '+relative+' '+from);evidence.push({file:relative,beforeHash:crypto.createHash('sha256').update(s).digest('hex'),anchor:from,count});fs.writeFileSync(f,s.split(from).join(to));}
 patch('lib/desktop-snap-lease-controller.js','function validateScope(s){','function validateScopeBase(s){');
 const controller=path.join(destination,'lib/desktop-snap-lease-controller.js');let s=fs.readFileSync(controller,'utf8');
 s+=`\nfunction validateScope(s){
 if(s?.kind!=='mixed-hidden-resident-prototype')return validateScopeBase(s);
 if(!Array.isArray(s.items)||s.items.length<2)return false;
 const links=s.items.filter(i=>i.mode==='hidden-link'),residents=s.items.filter(i=>i.mode==='resident-file');
 if(!links.length||!residents.length||links.length+residents.length!==s.items.length)return false;
 const all=new Set();for(const i of s.items){for(const k of new Set([key(i.path),key(i.destination)])){if(!k||all.has(k))return false;all.add(k);}}
 return validateScopeBase({...s,kind:'samepath-hidden',items:links})&&validateScopeBase({...s,kind:'resident-archive-samevolume',items:residents});
}\n`;
 fs.writeFileSync(controller,s);
 patch('lib/desktop-lease-watchdog.js',"active.scope.kind==='resident-archive-samevolume'?'source-restored':'hidden'","active.scope.kind==='mixed-hidden-resident-prototype'?'mixed-restored':active.scope.kind==='resident-archive-samevolume'?'source-restored':'hidden'",2);
 patch('scripts/shell-helper.ps1',"      'readHiddenFile'       { $result = Invoke-HiddenFileRequest $req $false }",`      'ciMixedHideOwned' {
       if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'}
       $p=[IO.Path]::GetFullPath([string]$req.path)
       if([IO.Path]::GetDirectoryName($p) -ine [Environment]::GetFolderPath('DesktopDirectory') -or [IO.Path]::GetFileName($p) -notmatch '^OkibaResident-[a-f0-9]{16}-'){throw 'owned fixture only'}
       $n=[OkibaFileAttributes]::SetRecordedAndNotify($p,[string]$req.expectedIdentity,[bool]$req.expectedHidden,$true,[string]$req.size,[string]$req.mtime,[uint32]$req.attributes)
       $result=@{ok=$true;hidden=$n.hidden;identity=$n.identity}
      }
      'readHiddenFile'       { $result = Invoke-HiddenFileRequest $req $false }`);
 const functions=['ValidateRecovery','Prepare','RevealPlace','RestoreVerify','Rollback','Release'];
 for(const name of functions)patch('scripts/snap-lease.ps1','function Lease-'+name+'(','function Lease-'+name+'-CoreMixedBase(');
 const native=path.join(root,'tools/mixed-lease-native-ci.ps1');if(!fs.existsSync(native))throw Error('Mixed native prototype unavailable');
 fs.copyFileSync(native,path.join(destination,'scripts/mixed-lease-native-ci.ps1'));
 fs.copyFileSync(path.join(root,'tools/mixed-rename-notify-ci.cs'),path.join(destination,'scripts/mixed-rename-notify-ci.cs'));
 fs.appendFileSync(path.join(destination,'scripts/snap-lease.ps1'),"\n. (Join-Path $PSScriptRoot 'mixed-lease-native-ci.ps1')\n");
 let host=fs.readFileSync(path.join(root,'tools/desktop-lease-protocol-host-ci.js'),'utf8').replace('hidden:true})),snapshot:spec.baseline','hidden:true,mode:i.mode})),snapshot:spec.baseline');
 host=host.replace("helper:{command:'powershell.exe'","helper:{env:{...process.env,OKIBA_MIXED_TRACE_PATH:path.join(spec.journalDir,'mixed-trace.jsonl')},command:'powershell.exe'");
 if(!host.includes('mode:i.mode'))throw Error('host mode anchor missing');
 fs.writeFileSync(path.join(destination,'tools/desktop-lease-protocol-host-ci.js'),host);
 fs.writeFileSync(path.join(destination,'copy-manifest.json'),JSON.stringify({researchOnly:true,evidence},null,2));
 return {directory:destination,helperPath:path.join(destination,'scripts/shell-helper.ps1'),hostPath:path.join(destination,'tools/desktop-lease-protocol-host-ci.js')};
}
module.exports={buildMixedCopy,ownedCopyDestination};
