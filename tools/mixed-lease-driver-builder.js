'use strict';
// Generate a hosted-only driver from the already-audited resident lifetime fixture.
// Fail on every anchor drift; this never patches the source driver or app runtime.
const fs=require('fs'),path=require('path');
function generateMixedDriver(copy,source){let s=fs.readFileSync(source,'utf8');
 function replace(a,b,n=1){if(s.split(a).length-1!==n)throw Error('Mixed driver anchor drift '+a);s=s.split(a).join(b);}
 replace("'success32','success34','abort-placed','abort-after-restore','fault-after-hide','fault-first-move','hang-first-move','owner-death','source-occupied','cached-destination','show-hidden-already-on','show-hidden-mid-stage'","'success32','abort-placed','abort-after-restore','fault-first-move','fault-first-reveal','hang-first-move','owner-death'");
 replace("kind:'resident-archive-samevolume'","kind:'mixed-hidden-resident-prototype'",2);
 replace("Array.from({length:3}","Array.from({length:6}");
 const item="return {name:base,path:source,dest,offset:[0,n]};";
 replace(item,"if(n<3){return {name:base,path:source,dest,mode:'hidden-link',offset:[Math.floor(n/3),n%3]};}return {name:base,path:source,dest,mode:'resident-file',offset:[Math.floor(n/3),n%3]};");
 replace('await attributes(items.map(i=>i.path),attrs);const contents=',"await attributes(items.filter(i=>i.mode==='hidden-link').map(i=>i.path),34);await attributes(items.filter(i=>i.mode==='resident-file').map(i=>i.path),32);for(const i of items.filter(i=>i.mode==='hidden-link')){fs.renameSync(i.path,i.dest);i.path=i.dest;}await returnedToBaseline();const contents=");
 replace('({path:i.path,destination:i.dest})','({path:i.path,destination:i.dest,hidden:i.mode===\'hidden-link\',mode:i.mode})');
 const a=s.indexOf("   if(name.startsWith('fault-')||name==='hang-first-move'){");const b=s.indexOf('   if(showCase){',a);if(a<0||b<a)throw Error('fault injection anchors');
 s=s.slice(0,a)+`   if(name.startsWith('fault-')||name==='hang-first-move'){
    const hd=path.join(dir,'helper');fs.mkdirSync(hd);for(const f of ['shell-helper.ps1','snap-lease.ps1','resident-lease.ps1','resident-file-native.cs','mixed-lease-native-ci.ps1'])fs.copyFileSync(path.join(root,'scripts',f),path.join(hd,f));helperPath=path.join(hd,'shell-helper.ps1');
    const f=path.join(hd,'mixed-lease-native-ci.ps1');let code=fs.readFileSync(f,'utf8');const marker=name==='fault-first-reveal'?'# CI-MIXED-AFTER-FIRST-REVEAL':'# CI-MIXED-AFTER-FIRST-STAGE';assert.equal(code.split(marker).length-1,1);
    const fault=name==='hang-first-move'?'Start-Sleep -Seconds 60':"throw 'CI mixed partial mutation'";
    fs.writeFileSync(f,code.replace(marker,marker+"\\n if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'};"+fault));
   }
`+s.slice(b);
 replace("const metadata=path.join(dir,'board.json'),beforeText='{\"resident\":true}',afterText='{\"resident\":false}';",`const metadata=path.join(dir,'board.json'),beforeText=JSON.stringify({positions:Object.fromEntries(items.filter(i=>i.mode==='resident-file').map(i=>[i.name,i.offset])),links:items.filter(i=>i.mode==='hidden-link').map(i=>({path:i.path,extra:'retain until commit'})),future:{unknown:[1,2]}}),afterText=JSON.stringify({positions:{},links:[],future:{unknown:[1,2]}});`);
 replace("assert(!fs.existsSync(i.path));assert(fs.readFileSync(i.dest).equals(contents[n]));","if(i.mode==='resident-file')assert(!fs.existsSync(i.path));assert(fs.readFileSync(i.dest).equals(contents[n]));");
 replace("assert.deepEqual(await attributes(items.map(i=>i.dest)),[32,32,32]);","assert.deepEqual(await attributes(items.map(i=>i.dest)),[32,32,32,32,32,32]);");
 replace("assert(!fs.existsSync(i.dest));assert(fs.readFileSync(i.path).equals(contents[n]));","if(i.mode==='resident-file')assert(!fs.existsSync(i.dest));assert(fs.readFileSync(i.path).equals(contents[n]));");
 replace("assert.deepEqual(await attributes(items.map(i=>i.path)),[attrs,attrs,attrs]);","assert.deepEqual(await attributes(items.map(i=>i.path)),[34,34,34,32,32,32]);");
 replace('  baseline=await stable();',"  assert.equal((await showPolicy('read')).value,false,'ShowHidden ON unsupported for initial Hidden link group');baseline=await stable();");
 replace("scope:'Hosted native resident new kind; main default unchanged'","scope:'Mixed private-copy research only; samepath selected initially visible is unsupported; production unchanged'");
 s=s.replaceAll('resident-lease-ci.json','mixed-lease-ci.json').replaceAll('resident-lease-ci-journals','mixed-lease-ci-journals');
 fs.writeFileSync(path.join(copy,'tools/mixed-driver-ci.js'),s);
 for(const file of ['stable-snapshot-ci.js','wait-owned-processes-ci.ps1','show-hidden-command-ci.ps1','show-hidden-fixture-ci.cs'])fs.copyFileSync(path.join(path.dirname(source),file),path.join(copy,'tools',file));
}
module.exports={generateMixedDriver};
