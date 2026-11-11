'use strict';
// Generate a hosted-only driver from the already-audited resident lifetime fixture.
// Fail on every anchor drift; this never patches the source driver or app runtime.
const fs=require('fs'),path=require('path');
function generateMixedDriver(copy,source){let s=fs.readFileSync(source,'utf8');
 function replace(a,b,n=1){if(s.split(a).length-1!==n)throw Error('Mixed driver anchor drift '+a);s=s.split(a).join(b);}
 replace("'success32','success34','abort-placed','abort-after-restore','fault-after-hide','fault-first-move','hang-first-move','owner-death','source-occupied','cached-destination','show-hidden-already-on','show-hidden-mid-stage'","'success32','abort-placed','abort-after-restore','fault-first-move','fault-first-reveal','hang-first-move','owner-death','success-dense','cached-destination','show-hidden-mid-stage'");
 replace("kind:'resident-archive-samevolume'","kind:'mixed-hidden-resident-prototype'",2);
 replace("Array.from({length:3}","Array.from({length:6}");
 const item="return {name:base,path:source,dest,offset:[0,n]};";
 replace(item,"if(n<3){return {name:base,path:source,dest,mode:'hidden-link',offset:[Math.floor(n/3),n%3]};}return {name:base,path:source,dest,mode:'resident-file',offset:[Math.floor(n/3),n%3]};");
 replace('await attributes(items.map(i=>i.path),attrs);const contents=',"await attributes(items.filter(i=>i.mode==='hidden-link').map(i=>i.path),34);await attributes(items.filter(i=>i.mode==='resident-file').map(i=>i.path),32);for(const i of items.filter(i=>i.mode==='hidden-link')){fs.renameSync(i.path,i.dest);i.path=i.dest;}await returnedToBaseline();const contents=");
 replace('({path:i.path,destination:i.dest})','({path:i.path,destination:i.dest,hidden:i.mode===\'hidden-link\',mode:i.mode})');
 const a=s.indexOf("   if(name.startsWith('fault-')||name==='hang-first-move'){");const b=s.indexOf('   if(showCase){',a);if(a<0||b<a)throw Error('fault injection anchors');
 s=s.slice(0,a)+`   if(name.startsWith('fault-')||name==='hang-first-move'){
    const hd=path.join(dir,'helper');fs.mkdirSync(hd);for(const f of ['shell-helper.ps1','snap-lease.ps1','resident-lease.ps1','resident-file-native.cs','mixed-lease-native-ci.ps1','mixed-rename-notify-ci.cs'])fs.copyFileSync(path.join(root,'scripts',f),path.join(hd,f));helperPath=path.join(hd,'shell-helper.ps1');
    const f=path.join(hd,'mixed-lease-native-ci.ps1');let code=fs.readFileSync(f,'utf8');const marker=name==='fault-first-reveal'?'# CI-MIXED-AFTER-FIRST-REVEAL':'# CI-MIXED-AFTER-FIRST-STAGE';assert.equal(code.split(marker).length-1,1);
    const fault=name==='hang-first-move'?'Start-Sleep -Seconds 60':"throw 'CI mixed partial mutation'";
    fs.writeFileSync(f,code.replace(marker,marker+"\\n if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'};"+fault));
   }
`+s.slice(b);
 // Reuse official ShowHidden fixture, but inject into the mixed first-stage boundary.
 replace("for(const f of ['shell-helper.ps1','snap-lease.ps1','resident-lease.ps1','resident-file-native.cs'])fs.copyFileSync", "for(const f of ['shell-helper.ps1','snap-lease.ps1','resident-lease.ps1','resident-file-native.cs','mixed-lease-native-ci.ps1','mixed-rename-notify-ci.cs'])fs.copyFileSync");
 replace("const f=path.join(hd,'resident-lease.ps1');let code=fs.readFileSync(f,'utf8');const anchor='  $null=[OkibaResidentFiles]::Stage($i.source,$i.destination,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID,$i.destParentID)';", "const f=path.join(hd,'mixed-lease-native-ci.ps1');let code=fs.readFileSync(f,'utf8');const anchor='# CI-MIXED-AFTER-FIRST-STAGE';");
 replace("if($selected.ContainsKey((Lease-Path $i.destination))){$proof.visible=$true;$proof.hidden=$true;$proof.oldUnchanged=$true;break}","$allLinksVisible=$true;foreach($link in $r.linkRecords){if(-not (Lease-CheckRecord $link).hidden -or -not $selected.ContainsKey((Lease-Path $link.path))){$allLinksVisible=$false}}\n    if($selected.ContainsKey((Lease-Path $i.destination)) -and $allLinksVisible){$proof.visible=$true;$proof.hidden=$true;$proof.oldUnchanged=$true;$proof.linksVisible=$true;$proof.linkCount=@($r.linkRecords).Count;break}");
 replace("assert(policy.stage.visible&&policy.stage.hidden&&policy.stage.oldUnchanged);", "assert(policy.stage.visible&&policy.stage.hidden&&policy.stage.oldUnchanged&&policy.stage.linksVisible&&policy.stage.linkCount===3);assert.equal((await showPolicy('read')).value,true,'Lease must not reset external ShowHidden');");
 replace("const metadata=path.join(dir,'board.json'),beforeText='{\"resident\":true}',afterText='{\"resident\":false}';",`const metadata=path.join(dir,'board.json'),beforeText=JSON.stringify({positions:Object.fromEntries(items.filter(i=>i.mode==='resident-file').map(i=>[i.name,i.offset])),links:items.filter(i=>i.mode==='hidden-link').map(i=>({path:i.path,extra:'retain until commit'})),future:{unknown:[1,2]}}),afterText=JSON.stringify({positions:{},links:[],future:{unknown:[1,2]}});`);
 replace("assert(!fs.existsSync(i.path));assert(fs.readFileSync(i.dest).equals(contents[n]));","if(i.mode==='resident-file')assert(!fs.existsSync(i.path));assert(fs.readFileSync(i.dest).equals(contents[n]));");
 replace("assert.deepEqual(await attributes(items.map(i=>i.dest)),[32,32,32]);","assert.deepEqual(await attributes(items.map(i=>i.dest)),[32,32,32,32,32,32]);");
 replace("assert(!fs.existsSync(i.dest));assert(fs.readFileSync(i.path).equals(contents[n]));","if(i.mode==='resident-file')assert(!fs.existsSync(i.dest));assert(fs.readFileSync(i.path).equals(contents[n]));");
 replace("assert.deepEqual(await attributes(items.map(i=>i.path)),[attrs,attrs,attrs]);","assert.deepEqual(await attributes(items.map(i=>i.path)),[34,34,34,32,32,32]);");
 replace('  baseline=await stable();',"  assert.equal((await showPolicy('read')).value,false,'ShowHidden ON unsupported for initial Hidden link group');baseline=await stable();");
 replace("helper:{command:'powershell.exe',args:","helper:{env:{...process.env,OKIBA_MIXED_TRACE_PATH:path.join(dir,'mixed-trace.jsonl')},command:'powershell.exe',args:");
 replace("const {diagnosticCopy}=require('./resident-diagnostic-copy-ci');", "");
 replace("   helperPath=diagnosticCopy(helperPath,dir);if(showCase)policy.proofPath=path.join(path.dirname(helperPath),'show-proof.json');", "");
 replace("const fs=require('fs')","const {runOwnedResidents}=require('./mixed-owned-resident-fixture-ci');\nconst fs=require('fs')");
 replace('let client=null,unsafe=false,baseline,policy=null;','let client=null,unsafe=false,baseline,policy=null,denseState=null;');
 replace("   const dir=path.join(temp,name);",`   if(name==='success-dense'){
    const seedDir=path.join(temp,'dense-old');fs.mkdirSync(seedDir);denseState={initialBaseline:baseline,files:[],planted:false};
    const seedItems=Array.from({length:42},(_,n)=>{const name=tag+'-dense-'+n+'.txt',source=path.join(seedDir,name),dest=path.join(desktop,name);fs.writeFileSync(source,'owned dense '+n);denseState.files.push({path:dest,bytes:fs.readFileSync(source)});return {name,path:source,dest,offset:[Math.floor(n/6),n%6]};});
    await attributes(seedItems.map(i=>i.path),32);const seedSnapshot=await stable(),seedPlan=planDesktop({snapshot:seedSnapshot,items:seedItems,automatic:true});assert(seedPlan.ok,JSON.stringify(seedPlan));
    client=createDesktopLeaseClient({journalDir:path.join(seedDir,'journal'),helperTimeoutMs:60000,helper:{env:{...process.env,OKIBA_MIXED_TRACE_PATH:path.join(seedDir,'mixed-trace.jsonl')},command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/shell-helper.ps1')]}});assert((await client.ready()).ok);
    report.denseSeed=await runOwnedResidents({client,items:seedItems,plan:seedPlan,snapshot:seedSnapshot,desktop,metadata:path.join(seedDir,'metadata.json'),runLease});assert((await client.close()).ok);client=null;
    const populated=await stable();for(const t of report.denseSeed.targets)assert(populated.icons.some(i=>i.path&&i.path.toLowerCase()===t.path.toLowerCase()&&i.x===t.x&&i.y===t.y));assert.equal(populated.icons.length,baseline.icons.length+42);baseline=populated;denseState.planted=true;report.denseOldCount=42;
   }
   const dir=path.join(temp,name);`);
 replace("    for(const i of items){assert(fs.existsSync(i.dest)&&!fs.existsSync(i.path));fs.renameSync(i.dest,i.path);}await returnedToBaseline();await attributes(items.map(i=>i.path),attrs);fs.writeFileSync(metadata,beforeText);",`    // Terminal seeded transaction; hide every actual destination before renaming residents.
    for(const i of items){assert(fs.existsSync(i.dest));const read=await observer.request('readHiddenFile',{path:i.dest});assert(read.ok&&read.result.ok);assert.equal(read.result.identity,scope.items[items.indexOf(i)].fileIdentity);assert(fs.readFileSync(i.dest).equals(contents[items.indexOf(i)]));const changed=await observer.request('ciMixedHideOwned',{path:i.dest,expectedIdentity:read.result.identity,expectedHidden:read.result.hidden,size:read.result.size,mtime:read.result.mtime,attributes:read.result.attributes});assert(changed.ok&&changed.result.ok);}
    await returnedToBaseline();
    for(const i of items){if(i.mode==='resident-file'){assert(!fs.existsSync(i.path));fs.renameSync(i.dest,i.path);}}
    await attributes(items.filter(i=>i.mode==='resident-file').map(i=>i.path),32);await returnedToBaseline();fs.writeFileSync(metadata,beforeText);`);
 replace("    fs.renameSync(guardSource,guardDest);const placed=await observer.request('positionDesktopPlan',{snapshot:guardBefore,targets:guardPlan.targets.map(t=>({...t,path:guardDest})),buffer:guardPlan.buffer});assert(placed.ok&&placed.result?.ok,JSON.stringify(placed));",`    await attributes([guardSource],32);const placed=await runOwnedResidents({client,items:[guardItem],plan:guardPlan,snapshot:guardBefore,desktop,metadata:path.join(dir,'guard-metadata.json'),runLease});assert(placed.result.ok);`);
 replace("if(baseline){await returnedToBaseline({cleanup:true});report.cleanupVerified=true;}",`if(denseState){if(denseState.planted)await stable();baseline=denseState.initialBaseline;for(const f of denseState.files){if(fs.existsSync(f.path)){assert.equal(path.dirname(f.path),desktop);assert(path.basename(f.path).startsWith(tag+'-dense-'));assert(fs.readFileSync(f.path).equals(f.bytes));fs.unlinkSync(f.path);}}}if(baseline){await returnedToBaseline({cleanup:true});report.cleanupVerified=true;}`);
 replace("scope:'Hosted native resident new kind; main default unchanged'","scope:'Mixed private-copy research only; samepath selected initially visible is unsupported; production unchanged'");
 s=s.replaceAll('resident-lease-ci.json','mixed-lease-ci.json').replaceAll('resident-lease-ci-journals','mixed-lease-ci-journals');
 fs.writeFileSync(path.join(copy,'tools/mixed-driver-ci.js'),s);
 for(const file of ['stable-snapshot-ci.js','wait-owned-processes-ci.ps1','show-hidden-command-ci.ps1','show-hidden-fixture-ci.cs','mixed-owned-resident-fixture-ci.js'])fs.copyFileSync(path.join(path.dirname(source),file),path.join(copy,'tools',file));
}
module.exports={generateMixedDriver};
