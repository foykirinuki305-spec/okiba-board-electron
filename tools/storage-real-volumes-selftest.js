'use strict';
// Opt-in real C/D integration tests. Only unique, identity-checked fixtures are touched.
const assert=require('assert'),fs=require('fs'),fsp=fs.promises,path=require('path'),os=require('os'),crypto=require('crypto');
const registry=require('../lib/external-boards');
const {createStorageBoardService}=require('../lib/storage-board-service');
const {createStorageTransfer,ordinaryAncestors}=require('../lib/storage-transfer');
let checks=0;const ok=(condition,message)=>{assert(condition,message);checks++;};
const bytes=Buffer.from(Array.from({length:262147},(_,i)=>(i*71)%256));
const id=s=>String(s.dev)+':'+String(s.ino);
async function fixture(fn){
 const token=crypto.randomUUID(),cParent=path.resolve(fs.realpathSync.native(os.tmpdir())),dParent='D:\\';
 assert.equal(path.parse(cParent).root.toUpperCase(),'C:\\','Requires C temp');
 await ordinaryAncestors(cParent);await ordinaryAncestors(dParent);
 assert.notEqual((await fsp.stat(cParent)).dev,(await fsp.stat(dParent)).dev,'C/D must be distinct volumes');
 const roots=[path.join(cParent,'okiba-real-volume-'+token),path.join(dParent,'okiba-real-volume-'+token)];
 const identities=new Map();
 try{
  for(const root of roots){await fsp.mkdir(root);identities.set(root,id(await fsp.lstat(root)));await fsp.writeFile(path.join(root,'.fixture-owner'),token,{flag:'wx'});}
  const [c,d]=roots,base=path.join(c,'boards'),source=path.join(c,'input'),out=path.join(c,'return'),stageC=path.join(c,'stage'),stageD=path.join(d,'stage');
  for(const p of [base,source,out,stageC,stageD])await fsp.mkdir(p);
  const cboard=path.join(base,'same-name');await fsp.mkdir(cboard);
  const cmeta=path.join(cboard,'.okiba-board.json'),craw='{"version":6,"positions":{"keep.txt":{"col":6,"row":3}},"links":[],"notes":[],"custom":"untouched"}\n';
  await fsp.writeFile(cmeta,craw);await fsp.writeFile(path.join(cboard,'keep.txt'),'C original');
  const b=registry.create(base,path.join(d,'resident'),'same-name');
  const opts={base,storageRoot:path.join(c,'journal'),stagingRootForSource:p=>path.parse(p).root.toUpperCase()==='C:\\'?stageC:stageD};
  const make=checkpoint=>createStorageBoardService({...opts,...(checkpoint?{engineFactory:o=>createStorageTransfer({...o,checkpoint})}:{})});
  ok(registry.resolve(base,'same-name').folder===cboard,'C same display routing');ok(registry.resolve(base,b.id).folder===b.folder,'D same display routing');
  await fn({base,source,out,b,cmeta,craw,make,service:make()});
  ok((await fsp.readFile(cmeta,'utf8'))===craw,'C layout byte identical');ok((await fsp.readFile(path.join(cboard,'keep.txt'),'utf8'))==='C original','C resident unchanged');
 }finally{
  // Never delete a path until its exact generated location, identity, owner and ancestors are checked.
  for(const root of roots){if(!identities.has(root))continue;const expected=path.join(root===roots[0]?cParent:dParent,'okiba-real-volume-'+token);assert.equal(path.resolve(root),expected);assert.equal(path.basename(root),'okiba-real-volume-'+token);await ordinaryAncestors(root);assert.equal(id(await fsp.lstat(root)),identities.get(root));assert.equal(await fsp.readFile(path.join(root,'.fixture-owner'),'utf8'),token);await fsp.rm(root,{recursive:true});assert(!fs.existsSync(root),'fixture cleanup');}
 }
}
async function seed(f,name='clip.bin'){const p=path.join(f.source,name);await fsp.writeFile(p,bytes);return p;}
(async()=>{
 if(process.platform!=='win32'||!process.argv.includes('--run'))throw Error('Run explicitly on Windows with --run; uses isolated C temp and D GUID folders');
 await fixture(async f=>{
  const a=await seed(f),dir=path.join(f.source,'音声画像');await fsp.mkdir(dir);await fsp.mkdir(path.join(dir,'empty'));await fsp.writeFile(path.join(dir,'音声.wav'),bytes);const r=await f.service.intake(f.b.id,[a,dir],{anchor:[2,3]});ok(r.ok,JSON.stringify(r));ok(!fs.existsSync(a)&&!fs.existsSync(dir),'sources removed after commit');
  const ma=JSON.parse(await fsp.readFile(path.join(f.b.folder,'.okiba-board.json'),'utf8'));ok(ma.externalBoardId===f.b.id,'external identity retained');assert.deepEqual(ma.positions['clip.bin'],{col:2,row:3});checks++;
  ok((await fsp.readFile(path.join(f.b.folder,'clip.bin'))).equals(bytes),'D binary verified');
  const ret=await f.service.takeout(f.b.id,[path.join(f.b.folder,'clip.bin'),path.join(f.b.folder,'音声画像')],f.out);ok(ret.ok,JSON.stringify(ret));ok((await fsp.readFile(path.join(f.out,'音声画像','音声.wav'))).equals(bytes),'C return binary verified');ok(fs.existsSync(path.join(f.out,'音声画像','empty')),'empty dir preserved');ok(!fs.existsSync(path.join(f.b.folder,'clip.bin')),'D source cleaned');
 });
 for(const phase of ['copied','staged'])for(const direction of ['intake','return'])await fixture(async f=>{
  const a=await seed(f,'resume.bin');if(direction==='return')ok((await f.service.intake(f.b.id,[a])).ok,'prepare return');const src=direction==='intake'?a:path.join(f.b.folder,'resume.bin'),dest=direction==='intake'?path.join(f.b.folder,'resume.bin'):path.join(f.out,'resume.bin');
  let fired=false;const interrupted=f.make(async current=>{if(current===phase&&!fired){fired=true;throw Error('injected interruption');}});const r=direction==='intake'?await interrupted.intake(f.b.id,[src]):await interrupted.takeout(f.b.id,[src],f.out);ok(fired&&!r.ok,'injected '+direction+' '+phase);ok((await fsp.readFile(dest)).equals(bytes),'verified destination survives');const preserved=phase==='copied'?src:r.items[0].backup;ok((await fsp.readFile(preserved)).equals(bytes),'original survives interruption');
  const recovery=await f.make().recover();ok(recovery.ok,JSON.stringify(recovery));ok(!fs.existsSync(src),'restart finishes source cleanup');ok((await fsp.readFile(dest)).equals(bytes),'restart preserves output');ok(!fs.existsSync(path.dirname(r.items[0].backup)),'backup staging cleaned');
 });
 await fixture(async f=>{const a=await seed(f,'collision.bin');ok((await f.service.intake(f.b.id,[a])).ok,'collision prep');const src=path.join(f.b.folder,'collision.bin'),dest=path.join(f.out,'collision.bin');await fsp.writeFile(dest,'existing destination');const meta=await fsp.readFile(path.join(f.b.folder,'.okiba-board.json'));const r=await f.service.takeout(f.b.id,[src],f.out);ok(!r.ok,'return collision blocked');ok((await fsp.readFile(src)).equals(bytes),'D original protected');ok((await fsp.readFile(dest,'utf8'))==='existing destination','C destination protected');ok((await fsp.readFile(path.join(f.b.folder,'.okiba-board.json'))).equals(meta),'D layout unchanged on collision');});

 // Whole-board migrations use a separate journal and two-board metadata commit.
 const {createBoardMigrationService}=require('../lib/board-migration-service');
 async function migrationFixture(f){
  const folder=path.join(f.base,'migration-source');await fsp.mkdir(folder);
  const linked=await seed(f,'linked.bin'),resident=path.join(folder,'resident.bin');await fsp.writeFile(resident,bytes);
  require('child_process').execFileSync('attrib',['+H',linked],{windowsHide:true});
  const data={version:6,size_percent:120,positions:{'resident.bin':{col:5,row:2}},links:[{path:linked,col:1,row:4,wasHidden:false}],notes:[{id:'n1',text:'fixture note',col:3,row:6}],custom:'retain-migration'};
  const meta=path.join(folder,'.okiba-board.json');await fsp.writeFile(meta,JSON.stringify(data,null,2));
  const make=checkpoint=>createBoardMigrationService({base:f.base,storageRoot:path.join(path.dirname(f.base),'migration-journal'),stagingRootForSource:p=>path.join(path.parse(p).root.toUpperCase()==='C:\\'?path.dirname(f.base):path.dirname(f.b.folder),'stage'),checkpoint});
  return {folder,linked,resident,data,meta,make};
 }
 function matchingLayout(actual,expected){
  assert.deepEqual(actual.positions,{'resident.bin':{col:5,row:2},'linked.bin':{col:1,row:4}});checks++;
  assert.deepEqual(actual.notes,expected.notes);checks++;ok(actual.size_percent===120,'migration visual scale');ok(actual.custom==='retain-migration','unknown field retained');ok(actual.links.length===0,'resident material mode');
 }
 async function emptySource(folder){
  const data=JSON.parse(await fsp.readFile(path.join(folder,'.okiba-board.json'),'utf8'));
  ok(Object.keys(data.positions).length===0&&data.links.length===0&&data.notes.length===0,'source state empty');
  assert.deepEqual(await fsp.readdir(folder),['.okiba-board.json']);checks++;
 }
 await fixture(async f=>{
  const m=await migrationFixture(f),service=m.make();
  let r=await service.migrate('migration-source',f.b.id);ok(r.ok,JSON.stringify(r));await emptySource(m.folder);
  ok(!fs.existsSync(m.linked),'C hidden linked original moved');
  let data=JSON.parse(await fsp.readFile(path.join(f.b.folder,'.okiba-board.json'),'utf8'));matchingLayout(data,m.data);ok(data.externalBoardId===f.b.id,'D identity');
  for(const name of ['resident.bin','linked.bin'])ok((await fsp.readFile(path.join(f.b.folder,name))).equals(bytes),'D whole-board data verified');
  const back=path.join(f.base,'migration-return');await fsp.mkdir(back);await fsp.writeFile(path.join(back,'.okiba-board.json'),JSON.stringify({version:6,positions:{},links:[],notes:[]}));
  r=await service.migrate(f.b.id,'migration-return');ok(r.ok,JSON.stringify(r));await emptySource(f.b.folder);
  data=JSON.parse(await fsp.readFile(path.join(back,'.okiba-board.json'),'utf8'));matchingLayout(data,m.data);ok(!data.externalBoardId,'C identity');ok(!fs.existsSync(m.linked),'not restored to desktop-like original path');
  for(const name of ['resident.bin','linked.bin'])ok((await fsp.readFile(path.join(back,name))).equals(bytes),'C whole-board data verified');
 });
 for(const blocked of ['same-name','shared'])await fixture(async f=>{
  const m=await migrationFixture(f);
  if(blocked==='same-name'){const p=path.join(f.source,'resident.bin');await fsp.writeFile(p,bytes);m.data.links.push({path:p,col:7,row:7,wasHidden:false});await fsp.writeFile(m.meta,JSON.stringify(m.data));}
  else{const p=path.join(f.base,'sharing');await fsp.mkdir(p);await fsp.writeFile(path.join(p,'.okiba-board.json'),JSON.stringify({version:6,positions:{},links:[{path:m.linked,col:0,row:0,wasHidden:false}],notes:[]}));}
  const before=await fsp.readFile(m.meta),dest=await fsp.readFile(path.join(f.b.folder,'.okiba-board.json'));
  await assert.rejects(()=>m.make().migrate('migration-source',f.b.id),blocked==='same-name'?/basename-collision/:/shared-source-reference/);checks++;
  ok((await fsp.readFile(m.meta)).equals(before),'rejected source layout identical');ok((await fsp.readFile(path.join(f.b.folder,'.okiba-board.json'))).equals(dest),'rejected dest layout identical');
  ok((await fsp.readFile(m.linked)).equals(bytes)&&(await fsp.readFile(m.resident)).equals(bytes),'rejected originals protected');
 });
 for(const direction of ['intake','return'])await fixture(async f=>{
  const m=await migrationFixture(f);let from='migration-source',to=f.b.id,sourceFolder=m.folder,destFolder=f.b.folder;
  if(direction==='return'){ok((await m.make().migrate(from,to)).ok,'prepare reverse interrupted migration');from=f.b.id;to='migration-source';sourceFolder=f.b.folder;destFolder=m.folder;}
  const before=await fsp.readFile(path.join(sourceFolder,'.okiba-board.json'));let interrupted=false;
  const service=m.make(async phase=>{if(phase==='metadata-0'&&!interrupted){interrupted=true;throw Error('injected one-side metadata interruption');}});
  const r=await service.migrate(from,to);ok(interrupted&&!r.ok,'half committed '+direction);
  ok((await fsp.readFile(path.join(sourceFolder,'.okiba-board.json'))).equals(before),'source metadata remains precommit');
  matchingLayout(JSON.parse(await fsp.readFile(path.join(destFolder,'.okiba-board.json'),'utf8')),m.data);
  for(const item of r.items)ok((await fsp.readFile(item.backup)).equals(bytes),'half commit original backup protected');
  const recovered=await m.make().recover();ok(recovered.ok,JSON.stringify(recovered));await emptySource(sourceFolder);
  matchingLayout(JSON.parse(await fsp.readFile(path.join(destFolder,'.okiba-board.json'),'utf8')),m.data);
  for(const name of ['resident.bin','linked.bin'])ok((await fsp.readFile(path.join(destFolder,name))).equals(bytes),'half commit recovery data');
 });

 console.log('PASS real C/D storage-board-service + whole-board migration: '+checks+' checks; isolated fixtures cleaned; user folders untouched');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
