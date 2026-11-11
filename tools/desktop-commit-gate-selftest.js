'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto');const {validReceipts}=require('../lib/desktop-commit-receipt');
const source=fs.readFileSync(require.resolve('../lib/desktop-lease-watchdog'),'utf8'),start=source.indexOf(" if(method==='prepareCommit'){"),end=source.indexOf(" if(method==='commitDone'){",start);assert(start>0&&end>start);const block=source.slice(start,end);
const receipts=[{path:'C:\\fixture\\meta.json',beforeHash:'a'.repeat(64),afterHash:'b'.repeat(64)}];let checks=0;
function fixture(){const c={unsafe:false,active:{phase:'restored',scope:{metadataPaths:receipts.map(r=>r.path)},permit:null},globalLock:{owned:()=>true},validReceipts,crypto,ownerState:async()=>({state:'alive'}),verifyVisible:async()=>{},allHash:()=>true,receiptsNow:()=>[],saves:0,save(){c.saves++;}};vm.createContext(c);vm.runInContext('this.invoke=async function(method,args){'+block+'}',c);return c;}
(async()=>{
let c=fixture();const gate=await c.invoke('prepareCommit',['token',receipts]);assert(gate.ok&&c.active.permitDurable&&c.saves===1);checks++;
const second=await c.invoke('prepareCommit',['token',receipts.map(r=>({...r}))]);assert.equal(second.permit,gate.permit);assert.equal(c.saves,1);checks++; // includes a lost first response: permission is not regenerated.
await assert.rejects(c.invoke('prepareCommit',['token',[{...receipts[0],afterHash:'c'.repeat(64)}]]),/receipts-changed/);assert.equal(c.saves,1);checks++;
c=fixture();c.save=()=>{c.unsafe=true;throw Error('EPERM');};await assert.rejects(c.invoke('prepareCommit',['token',receipts]),/EPERM/);const retained=c.active.permit;assert(retained&&c.active.permitDurable===false);await assert.rejects(c.invoke('prepareCommit',['token',receipts]),/state-unconfirmed/);assert.equal(c.active.permit,retained);checks++;
c.unsafe=false;await assert.rejects(c.invoke('prepareCommit',['token',receipts]),/not-durable/);checks++;
for(const phase of ['aborted','released','blocked','committing-visible']){c=fixture();c.active={...c.active,phase,permit:'old',permitDurable:true,receipts};await assert.rejects(c.invoke('prepareCommit',['token',receipts]),/state-unconfirmed/);checks++;}
c=fixture();c.globalLock.owned=()=>false;await assert.rejects(c.invoke('prepareCommit',['token',receipts]),/state-unconfirmed/);assert(!c.active.permit);checks++;
c=fixture();c.ownerState=async()=>({state:'exited'});await assert.rejects(c.invoke('prepareCommit',['token',receipts]),/owner-not-alive/);assert(!c.active.permit);checks++;
console.log('durable commit gate '+checks+' checks PASS (actual watchdog block, pure VM)');
})().catch(e=>{console.error(e);process.exitCode=1;});
