'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const cache=require('../lib/desktop-calibration-cache');let n=0;
const check=(name,fn)=>{fn();n++;console.log('ok - '+name);};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-cal-cache-')),file=path.join(root,'cache.json');
try{
 check('missing cache ignored',()=>assert.equal(cache.load(file),null));
 const good={version:1,entries:[{proof:{samples:[{x:1,y:2}]},grid:{sx:100},geometry:'opaque'}]};
 check('evidence round trip',()=>{assert(cache.save(file,good));assert.deepEqual(cache.load(file),good);});
 check('board unrelated data untouched',()=>{const board=path.join(root,'board.json');fs.writeFileSync(board,'original');cache.save(file,good);assert.equal(fs.readFileSync(board,'utf8'),'original');});
 check('more than four entries rejected, previous retained',()=>{assert(!cache.save(file,{version:1,entries:Array(5).fill({})}));assert.deepEqual(cache.load(file),good);});
 check('oversized output rejected without replacing prior cache',()=>{assert(!cache.save(file,{version:1,entries:[{x:'x'.repeat(cache.MAX_BYTES)}]}));assert.deepEqual(cache.load(file),good);});
 check('wrong version ignored',()=>{fs.writeFileSync(file,JSON.stringify({version:2,entries:[]}));assert.equal(cache.load(file),null);});
 check('corrupt cache ignored',()=>{fs.writeFileSync(file,'{broken');assert.equal(cache.load(file),null);});
 check('oversized input ignored',()=>{fs.writeFileSync(file,'x'.repeat(cache.MAX_BYTES+1));assert.equal(cache.load(file),null);});
 check('invalid entry shape ignored',()=>{fs.writeFileSync(file,JSON.stringify({version:1,entries:[null]}));assert.equal(cache.load(file),null);});
 check('atomic save leaves no extra tmp files',()=>{assert(cache.save(file,good));assert(!fs.readdirSync(root).some(f=>f.endsWith('.tmp')));});
 console.log('calibration cache: '+n+' checks passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
