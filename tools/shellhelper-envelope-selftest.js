'use strict';
const assert=require('assert/strict'),path=require('path'),{createShellHelperClient,escapeLine}=require('../lib/shellhelper');
(async()=>{let spawns=0;const absent=createShellHelperClient({command:'never-spawn',spawnFn:()=>{spawns++;throw Error('unexpected spawn');}});let count=0;for(const payload of [{id:0},{id:undefined},{cmd:'other'},Object.defineProperty({},'cmd',{get(){throw Error('must not invoke getter');}})]){const r=await absent.request('resolveDrop',payload);assert.equal(r.error,'reserved-payload-field');count++;}assert.equal(spawns,0);assert.equal(absent.stats().requests,0);
 const c=createShellHelperClient({command:process.execPath,args:[path.join(__dirname,'fake-helper.js')],env:{...process.env,OKIBA_FAKE_LEASE:'0',OKIBA_FAKE_CALIBRATION:'0',OKIBA_FAKE_LANDING:'C:\\synthetic',ELECTRON_RUN_AS_NODE:'1'}});
 try{const first=await c.request('resolveDrop',{x:7,nested:{id:0,cmd:'allowed'},name:'日本語'});assert(first.ok&&first.result.echo===7);count++;
 const before=c.stats();assert.equal((await c.request('resolveDrop',{id:0})).error,'reserved-payload-field');assert.deepEqual(c.stats(),before);count++;
 const both=await Promise.all([c.request('resolveDrop',{x:8}),c.request('resolveDrop',{x:9})]);assert.deepEqual(both.map(r=>r.result.echo),[8,9]);count++;
 const line=escapeLine(JSON.stringify({name:'日本語'}));assert(!/[^\x00-\x7F]/.test(line));assert.equal(JSON.parse(line).name,'日本語');count++;
 }finally{assert(await c.stopAndWait(5000));}console.log('shellhelper envelope '+count+' checks PASS');})().catch(e=>{console.error(e);process.exitCode=1;});
