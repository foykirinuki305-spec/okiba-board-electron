'use strict';
// Hosted fixture helper; every item is a newly created, caller-owned TEMP file.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
async function runOwnedResidents({client,items,plan,snapshot,desktop,metadata,runLease}){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted fixture only');
 assert(plan.ok);const before='{"fixture":"before"}',after='{"fixture":"after"}';fs.writeFileSync(metadata,before,{flag:'wx'});
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),targets=plan.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest}));
 const targetAreaIndex=snapshot.areas.findIndex(a=>targets.every(t=>t.x>=a.left&&t.x<a.right&&t.y>=a.top&&t.y<a.bottom));
 const scope=await client.prepareScope({kind:'resident-archive-samevolume',desktop,items:items.map(i=>({path:i.path,destination:i.dest})),snapshot,targetAreaIndex,targets,metadataPaths:[metadata]});
 const result=await runLease({scope,receipts:[{path:metadata,beforeHash:hash(before),afterHash:hash(after)}],adapter:client.adapter(async()=>{const tmp=metadata+'.tmp';fs.writeFileSync(tmp,after,{flag:'wx'});fs.renameSync(tmp,metadata);})});
 assert(result.ok,JSON.stringify(result));assert.equal(fs.readFileSync(metadata,'utf8'),after);return {result,targets};
}
module.exports={runOwnedResidents};
