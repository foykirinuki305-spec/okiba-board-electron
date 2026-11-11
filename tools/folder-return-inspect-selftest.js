'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert'),{spawnSync}=require('child_process');
const {nativeCall,stopNative}=require('../lib/folder-return');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-inspect-test-')),script=path.resolve(__dirname,'../scripts/folder-return.ps1');
 try{
  const file=path.join(root,'generated-'+String.fromCharCode(26085,26412,35486)+'.txt'),dir=path.join(root,'folder'),missing=path.join(root,'absent.txt');fs.writeFileSync(file,'TEMP inspection fixture');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'child.txt'),'not recursively inspected');
  const attr=spawnSync('attrib.exe',['+H',file],{windowsHide:true,encoding:'utf8'});assert.equal(attr.status,0);
  const before={bytes:fs.readFileSync(file),mtime:fs.statSync(file).mtimeMs,names:fs.readdirSync(root),children:fs.readdirSync(dir)};
  const r=await nativeCall(script,{action:'inspect',paths:[file,dir,missing]});assert.equal(r.records.length,2);assert.equal(r.failed.length,1);assert.equal(r.failed[0].path,missing);
  const f=r.records.find(x=>x.path===file),d=r.records.find(x=>x.path===dir);assert(f.identity&&f.volume&&f.size&&f.mtime&&f.regularFile&&f.hidden);assert(!d.regularFile&&d.identity);assert(!r.records.some(x=>x.path.endsWith('child.txt')));
  const again=await nativeCall(script,{action:'inspect',paths:[file]});assert.equal(again.records[0].identity,f.identity);assert.equal(again.records[0].attributes,f.attributes);assert(again.records[0].hidden);assert.deepStrictEqual(fs.readFileSync(file),before.bytes);assert.equal(fs.statSync(file).mtimeMs,before.mtime);assert.deepStrictEqual(fs.readdirSync(root),before.names);assert.deepStrictEqual(fs.readdirSync(dir),before.children);
  await assert.rejects(()=>nativeCall(script,{action:'inspect',paths:[file,file]}),/duplicate/);await assert.rejects(()=>nativeCall(script,{action:'inspect',paths:[]}),/invalid/);
  const invalid=await nativeCall(script,{action:'inspect',paths:['relative.txt']});assert.equal(invalid.records.length,0);assert.equal(invalid.failed.length,1);
  const one=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{input:JSON.stringify({action:'inspect',paths:[file]})+'\n',encoding:'utf8',windowsHide:true});assert.equal(one.status,0);assert.equal(JSON.parse(one.stdout).records[0].identity,f.identity);
  console.log('PASS native inspect: exact path file/folder, mixed missing, no recursion, unchanged bytes/mtime/listing, repeat identity, malformed requests, one-shot');
 }finally{stopNative();assert(root.startsWith(path.join(os.tmpdir(),'okiba-inspect-test-')));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
