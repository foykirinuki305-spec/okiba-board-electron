'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');const {createLeaseJournal}=require('../lib/desktop-lease-journal');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-lease-journal-test-'));const j=createLeaseJournal(dir);let checks=0;
try{
 const token='a'.repeat(32);j.write({token,phase:'prepared'});assert.equal(j.pending().length,1);checks++;
 j.write({token,phase:'released'});assert.equal(j.pending().length,0);checks++;
 for(let n=0;n<15;n++)j.write({token:n.toString(16).padStart(32,'0'),phase:'aborted',updatedAt:new Date(1000+n).toISOString()});
 assert.equal(j.pending().length,0);assert.equal(fs.readdirSync(dir).filter(x=>x.endsWith('.json')).length,10);checks++;
 const tmp=path.join(dir,'interrupted.tmp');fs.writeFileSync(tmp,'evidence');assert.throws(()=>j.pending(),/unresolved-journal-temp/);assert(fs.existsSync(tmp));fs.unlinkSync(tmp);checks++;
 const bad=path.join(dir,'f'.repeat(32)+'.json');fs.writeFileSync(bad,'bad-json');assert.throws(()=>j.pending());assert(fs.existsSync(bad));checks++;
 console.log('PASS durable lease journal '+checks+' checks');
}finally{assert(path.basename(dir).startsWith('okiba-lease-journal-test-'));fs.rmSync(dir,{recursive:true,force:true});}
