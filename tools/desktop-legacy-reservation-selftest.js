'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm'),{createRequire}=require('module');
const {validLegacyProof,legacyTerminal}=require('../lib/desktop-legacy-reservation');
const filename=path.resolve(__dirname,'../lib/desktop-lease-watchdog.js');const source=fs.readFileSync(filename,'utf8').split("process.on('error',()=>{});")[0];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-legacy-reservation-'));
const proof={outcome:'committed',mutationsSettled:true,metadataSettled:true,oldUnchanged:true,helper:{allRequestsCompleted:true,stopConfirmed:false}};
let checks=0;
function setup(){
 const events=[],records=[];let held=false,busy=false,releaseFail=false,alive=true;const proc={connected:true,pid:123,ppid:122};
 const context=vm.createContext({require:createRequire(filename),process:proc,console,Buffer,setTimeout,clearTimeout});
 vm.runInContext(source+`\ninitialized=true;config={};owner={pid:122,started:'1'};journal={dir:${JSON.stringify(root)},pending:()=>[],write:r=>record(JSON.parse(JSON.stringify(r)))};helper={request:async cmd=>({ok:true,result:{ok:true,state:ownerAlive()?'alive':'exited'}})};globalLock=lock;globalThis.api={call:dispatch,get:()=>active,set:a=>{active=a},resolve,terminal};`,Object.assign(context,{record:r=>records.push(r),ownerAlive:()=>alive,lock:{desktop:fs.realpathSync.native(root).toLowerCase(),owned:()=>held,begin:async()=>{events.push('begin');if(busy)throw Error('desktop-lease-busy');held=true;},update:()=>events.push('persist-pointer'),release:async()=>{events.push('release');if(releaseFail)throw Error('release-failed');held=false;}}}));
 return {api:context.api,events,records,proc,held:()=>held,busy:v=>busy=v,alive:v=>alive=v,releaseFail:v=>releaseFail=v};
}
(async()=>{try{
 assert(validLegacyProof(proof));checks++;
 assert(validLegacyProof({...proof,helper:{allRequestsCompleted:false,stopConfirmed:true}}));checks++;
 for(const key of ['mutationsSettled','metadataSettled','oldUnchanged']){assert(!validLegacyProof({...proof,[key]:false}));checks++;}
 assert(!validLegacyProof({...proof,helper:{allRequestsCompleted:false,stopConfirmed:false}}));checks++;
 let s=setup();let r=await s.api.call('reserveLegacy',[{desktop:root}]);assert(r.ok&&s.held());assert.equal(s.records.at(-1).mode,'legacy-reservation');checks++;
 await assert.rejects(s.api.call('revealAndPlace',[r.token]),/legacy-operation/);await assert.rejects(s.api.call('abort',[r.token]),/legacy-operation/);assert(s.held());checks++;
 await assert.rejects(s.api.call('releaseLegacy',[r.token,{...proof,oldUnchanged:false}]),/completion-unconfirmed/);assert(s.held());checks++;
 let end=await s.api.call('releaseLegacy',[r.token,proof]);assert(end.ok&&end.leaseReleased&&!s.held());assert.equal(s.records.at(-1).phase,'released');checks++;
 assert((await s.api.call('releaseLegacy',[r.token,proof])).ok);checks++;
 s=setup();s.busy(true);await assert.rejects(s.api.call('reserveLegacy',[{desktop:root}]),/busy/);assert.equal(s.records.length,0);checks++;
 s=setup();r=await s.api.call('reserveLegacy',[{desktop:root}]);s.proc.connected=false;await assert.rejects(s.api.call('releaseLegacy',[r.token,proof]),/state-unknown/);assert(s.held());checks++;
 s=setup();r=await s.api.call('reserveLegacy',[{desktop:root}]);s.alive(false);await assert.rejects(s.api.call('releaseLegacy',[r.token,proof]),/owner-not-alive/);end=await s.api.resolve();assert.equal(end.state,'blocked');assert(s.held());checks++;
 s=setup();r=await s.api.call('reserveLegacy',[{desktop:root}]);s.releaseFail(true);await assert.rejects(s.api.call('releaseLegacy',[r.token,proof]),/release-failed/);assert.equal(s.api.terminal(),null);assert(s.held());checks++;
 assert.equal(legacyTerminal({mode:'legacy-reservation',phase:'released'},true),null);checks++;
 console.log('PASS legacy reservation '+checks+' checks: production dispatch, durable gate, disconnected/dead owner, no snap rollback, failed release retained');
}finally{assert(path.basename(root).startsWith('okiba-legacy-reservation-'));fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
