'use strict';
// CI-only real cross-volume proof, never operates on Desktop or user assets.
const fs=require('fs'),fsp=fs.promises,path=require('path'),os=require('os'),assert=require('assert/strict');
const {createCrossVolumeMove}=require('../lib/cross-volume-move');
(async()=>{
 if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('CI Windows only: local execution forbidden');
 const candidates=[os.tmpdir(),process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Temp'),process.env.RUNNER_TEMP].filter(Boolean);
 const parents=[];for(const p of candidates){try{const st=await fsp.stat(p);if(st.isDirectory()&&!parents.some(x=>x.dev===st.dev))parents.push({path:path.resolve(p),dev:st.dev});}catch(_){}}
 if(parents.length<2)throw Error('Two actual writable volumes required for cross-volume verification');
 const roots=[];
 try{
  for(const p of parents.slice(0,2))roots.push({path:await fsp.mkdtemp(path.join(p.path,'okiba-cross-ci-')),parent:p.path});
  for(let direction=0;direction<2;direction++)for(const folder of [false,true]){
   const source=path.join(roots[direction].path,'source-'+folder),dest=path.join(roots[1-direction].path,'dest-'+folder);
   if(folder){await fsp.mkdir(source);await fsp.mkdir(path.join(source,'nested'));await fsp.writeFile(path.join(source,'nested','file.txt'),'cross-volume payload');}
   else await fsp.writeFile(source,'cross-volume payload');
   assert.notEqual((await fsp.stat(source)).dev,(await fsp.stat(path.dirname(dest))).dev);
   let t=createCrossVolumeMove(source,dest,{stagingParent:roots[direction].path});
   await t.prepare();assert(fs.existsSync(source));await t.stageSource();await t.rollback();assert(fs.existsSync(source)&&!fs.existsSync(dest));
   t=createCrossVolumeMove(source,dest,{stagingParent:roots[direction].path});await t.prepare();await t.stageSource();assert((await t.cleanup()).ok);assert(!fs.existsSync(source)&&fs.existsSync(dest));
   console.log('PASS real cross-volume direction='+direction+' folder='+folder);
  }
 }finally{
  for(const root of roots){const rel=path.relative(root.parent,path.resolve(root.path));if(!rel.startsWith('okiba-cross-ci-')||rel.includes(path.sep))throw Error('Unsafe test cleanup target');await fsp.rm(root.path,{recursive:true,force:true});}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
