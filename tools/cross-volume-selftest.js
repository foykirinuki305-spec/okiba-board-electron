'use strict';
const fs=require('fs'), fsp=fs.promises,os=require('os'),path=require('path'),assert=require('assert/strict');
const {createCrossVolumeMove}=require('../lib/cross-volume-move');
let checks=0;const ok=(v,m)=>{assert(v,m);checks++;console.log('ok - '+m);};
(async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'okiba-cross-test-'));
 try{
  const src=path.join(root,'source'),dst=path.join(root,'destination');await fsp.mkdir(src);await fsp.mkdir(dst);
  const make=async(name,dir=false)=>{const a=path.join(src,name),b=path.join(dst,name);if(dir){await fsp.mkdir(a);await fsp.mkdir(path.join(a,'nested'));await fsp.writeFile(path.join(a,'nested','日本語.txt'),'payload');await fsp.mkdir(path.join(a,'empty'));}else await fsp.writeFile(a,'payload');return [a,b,createCrossVolumeMove(a,b,{stagingParent:root})];};
  for(const dir of [false,true]){
   let [a,b,t]=await make(dir?'folder':'file',dir);await t.prepare();ok(fs.existsSync(a)&&fs.existsSync(b),'prepare retains original '+dir);await t.stageSource();ok(!fs.existsSync(a)&&fs.existsSync(b),'source staged after placement '+dir);await t.rollback();ok(fs.existsSync(a)&&!fs.existsSync(b),'rollback restores original '+dir);
   [a,b,t]=await make(dir?'folder-success':'file-success',dir);await t.prepare();await t.stageSource();const result=await t.cleanup();ok(result.ok&&!fs.existsSync(a)&&fs.existsSync(b),'committed cleanup verified '+dir);
  }
  let [a,b,t]=await make('occupied');await fsp.writeFile(b,'user');await assert.rejects(t.prepare(),/destination-occupied/);ok((await fsp.readFile(b,'utf8'))==='user'&&fs.existsSync(a),'existing destination untouched');
  [a,b,t]=await make('sourcechanged');await t.prepare();await fsp.writeFile(a,'new source');await assert.rejects(t.stageSource(),/source-changed/);ok((await fsp.readFile(a,'utf8'))==='new source','source modification survives');
  [a,b,t]=await make('destchanged');await t.prepare();await fsp.writeFile(b,'user edited destination');await assert.rejects(t.rollback(),/destination-changed/);ok(fs.existsSync(a)&&(await fsp.readFile(b,'utf8'))==='user edited destination','changed destination never deleted');
  [a,b,t]=await make('sourcecollision');await t.prepare();await t.stageSource();await fsp.writeFile(a,'new unrelated');await assert.rejects(t.rollback(),/original-path-occupied/);ok((await fsp.readFile(a,'utf8'))==='new unrelated'&&fs.existsSync(b),'rollback never overwrites new source');
  [a,b,t]=await make('cleanupchanged');await t.prepare();await t.stageSource();await fsp.writeFile(b,'edited');const r=await t.cleanup();ok(!r.ok&&r.recovery.some(p=>p.endsWith('original')&&fs.existsSync(p)),'cleanup failure retains staged original');
  [a,b,t]=await make('badstage');t=createCrossVolumeMove(a,b,{stagingParent:path.join(root,'does-not-exist')});await assert.rejects(t.prepare());ok(fs.existsSync(a)&&!fs.existsSync(b),'staging unavailable aborts before destination copy');
  const external=path.join(root,'junction-target');await fsp.mkdir(external);await fsp.writeFile(path.join(external,'keep.txt'),'keep');
  const junction=path.join(src,'junction');await fsp.symlink(external,junction,process.platform==='win32'?'junction':'dir');
  t=createCrossVolumeMove(junction,path.join(dst,'junction'),{stagingParent:root});await assert.rejects(t.prepare(),/unsupported-reparse/);ok((await fsp.readFile(path.join(external,'keep.txt'),'utf8'))==='keep','junction rejected without following or altering target');
  [a,b,t]=await make('foldercollision',true);await t.prepare();await t.stageSource();await fsp.mkdir(a);await fsp.writeFile(path.join(a,'new.txt'),'new');await assert.rejects(t.rollback(),/original-path-occupied/);ok((await fsp.readFile(path.join(a,'new.txt'),'utf8'))==='new','directory rollback never merges or overwrites occupied original path');
  [a,b]=await make('late-stage');let calls=0;t=createCrossVolumeMove(a,b,{stagingParent:root,moveNoReplace:async(from,to)=>{await fsp.rename(from,to);if(++calls===1)throw Error('timed-out-after-rename');}});await t.prepare();await assert.rejects(t.stageSource(),/timed-out/);await t.rollback();ok(fs.existsSync(a)&&!fs.existsSync(b),'stopped helper late stage success is recovered without loss');
  [a,b]=await make('late-rollback');calls=0;t=createCrossVolumeMove(a,b,{stagingParent:root,moveNoReplace:async(from,to)=>{await fsp.rename(from,to);if(++calls===2)throw Error('timed-out-after-restore');}});await t.prepare();await t.stageSource();await t.rollback();ok(fs.existsSync(a)&&!fs.existsSync(b),'stopped helper late restore is verified and completed');
  [a,b]=await make('unsafe-stage');t=createCrossVolumeMove(a,b,{stagingParent:root,moveNoReplace:async()=>{const e=Error('helper-still-running');e.unsafe=true;throw e;}});await t.prepare();await assert.rejects(t.stageSource(),e=>e.unsafe);ok(fs.existsSync(a)&&fs.existsSync(b),'unsafe helper failure propagates without restore/delete');
  assert.throws(()=>createCrossVolumeMove(src,path.join(src,'inside')),/overlapping/);checks++;
  const oldTmp=os.tmpdir,excludedTmp=path.join(root,'excluded-tmp'),safeStage=path.join(root,'safe-stage');await fsp.mkdir(excludedTmp);await fsp.mkdir(safeStage);
  try {
   os.tmpdir=()=>excludedTmp;
   [a,b]=await make('staging-fallback');t=createCrossVolumeMove(a,b,{stagingParents:[path.join(root,'missing'),safeStage],stagingExcludedRoots:[excludedTmp]});await t.prepare();ok(path.dirname(path.dirname(t.backupPath))===safeStage,'excluded OS temp and invalid candidate fall back to safe source-volume ancestor');await t.rollback();
   [a,b]=await make('staging-priority');t=createCrossVolumeMove(a,b,{stagingParents:[safeStage]});await t.prepare();ok(path.dirname(path.dirname(t.backupPath))===excludedTmp,'same-volume OS temp remains first choice');await t.rollback();
   [a,b]=await make('staging-all-excluded');t=createCrossVolumeMove(a,b,{stagingParents:[safeStage],stagingExcludedRoots:[path.parse(root).root]});await assert.rejects(t.prepare(),/staging-unavailable/);ok(fs.existsSync(a)&&!fs.existsSync(b),'all excluded candidates abort before copying');
   [a,b]=await make('staging-explicit-excluded');t=createCrossVolumeMove(a,b,{stagingParent:safeStage,stagingExcludedRoots:[safeStage]});await assert.rejects(t.prepare(),/excluded-path/);ok(fs.existsSync(a)&&!fs.existsSync(b),'explicit excluded staging parent fails closed');
  }finally{os.tmpdir=oldTmp;}
  console.log('cross-volume selftest: '+checks+' checks passed');
 }finally{await fsp.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});


