// Source/guard contract only. Does not claim native session reuse success.
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm'),cp=require('child_process');
const read=n=>fs.readFileSync(path.join(__dirname,n),'utf8');
const driver=read('formal-unknown-reuse-ci.js'),host=read('formal-unknown-reuse-host-ci.js');
for(const s of [driver,host]){new vm.Script(s);assert(s.includes("process.env.GITHUB_ACTIONS!=='true'"));assert(s.includes("process.env.RUNNER_ENVIRONMENT!=='github-hosted'"));}
const refusal=cp.spawnSync(process.execPath,['-e',host],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'false'},windowsHide:true});assert.notEqual(refusal.status,0);assert(refusal.stderr.includes('Hosted unknown success CI only'));
for(const x of ['sessionCalibrationCount,1','sessionCalibrationCount,0','old.identity','no-fit must make no helper request','same dedicated helper must be retained','calibrationCallsAfter,0','adapter:client.adapter(async()=>'])assert(host.includes(x),x);
assert(host.indexOf('const previousStop=await closeVerified()')>host.indexOf('assert(known.ok')); 
assert(driver.includes('selected.slice(0,3)'));assert(driver.includes('secondItems:selected.slice(3)'));assert(driver.includes('(commits?6:0)'));assert(driver.includes('if(!unsafe)'));assert(driver.includes('cleanupVerified=true'));
const original=read('formal-unknown-dpi-empty-ci.ps1'),clone=read('formal-unknown-reuse-dpi-ci.ps1');assert.equal(clone,original.replaceAll('formal-unknown-success','formal-unknown-reuse').replaceAll("'success,no-fit'","'success'"),'150 setup/restore logic must remain an exact clone');
console.log('PASS reuse source/guard contracts, actual non-hosted refusal, same-helper/request-count proof assertions, byte-equivalent DPI restoration clone; native NOT executed');

assert(host.includes('cacheStatus.calibrationCache?.ok'));for(const k of ['clientSetupElapsedMs','firstUnknownElapsedMs','secondKnownElapsedMs'])assert(host.includes(k));assert(driver.includes('[selected.slice(0,3),selected.slice(3,6)]'));assert(driver.includes('assert.equal(group.length,3)'));assert(driver.includes('JSON.stringify(group.map'));assert(!driver.includes('JSON.stringify(selected.map'));console.log('PASS status cache contract, separate timings, exactly two cleanup batches of three');
