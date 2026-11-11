'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{spawnSync}=require('child_process'),vm=require('vm');
const root=path.resolve(__dirname,'..');
for(const [source,formal]of [['unknown-grid-lease-flow-ci','desktop-unknown-lease-flow'],['unknown-grid-success-flow-ci','desktop-unknown-success-flow']]){
 const original=fs.readFileSync(path.join(__dirname,source+'.js'),'utf8').replace(/^\/\/[^\n]*\n/,'').replaceAll('samepath-hidden-unknown-grid-ci','samepath-hidden-unknown-grid').replaceAll("'unknown-ci'","'unknown-grid'");
 const current=fs.readFileSync(path.join(root,'lib',formal+'.js'),'utf8').replace(/^\/\/[^\n]*\n/,'');assert.equal(current.replaceAll('\r\n','\n'),original.replaceAll('\r\n','\n'),'mechanical protocol parity '+formal);
 const test=fs.readFileSync(path.join(__dirname,source.replace('-ci','-selftest')+'.js'),'utf8').replaceAll("require('./"+source+"')","require('../lib/"+formal+"')").replaceAll('samepath-hidden-unknown-grid-ci','samepath-hidden-unknown-grid').replaceAll("'unknown-ci'","'unknown-grid'");
 const r=spawnSync(process.execPath,['-e',test],{cwd:__dirname,encoding:'utf8',windowsHide:true});process.stdout.write(r.stdout||'');if(r.status!==0)throw Error(r.stderr||'formal flow test failed');
}
const code=fs.readFileSync(path.join(root,'lib/desktop-lease-watchdog.js'),'utf8');
const envSource=code.slice(code.indexOf('function unknownHelperEnv('),code.indexOf('function makeHelper('));const env=vm.runInNewContext(envSource+';unknownHelperEnv');
assert.equal(env({OKIBA_UNKNOWN_GRID_LEASE:'1',okiba_unknown_validator_exe:'evil',OTHER:'keep'},false).OKIBA_UNKNOWN_GRID_LEASE,'');assert(!Object.hasOwn(env({okiba_unknown_validator_exe:'evil'},true),'okiba_unknown_validator_exe'));assert.equal(env({},true).OKIBA_UNKNOWN_GRID_LEASE,'1');assert.equal(env({},'true').OKIBA_UNKNOWN_GRID_LEASE,'');
const start=code.indexOf(' // BEGIN formal unknown dispatch'),end=code.indexOf(' // END formal unknown dispatch',start);assert(start>=0&&end>start);const dispatch=new (Object.getPrototypeOf(async function(){}).constructor)('method','args','config','active','done','journal','formalUnknownFlow','formalUnknownSuccess',code.slice(start,end));
(async()=>{let calls=0;const flow={prepare:async()=>{calls++;return {ok:true};}};await assert.rejects(dispatch('unknown-prepare',[],{},null,()=>false,{pending:()=>[]},flow,{}),/disabled/);assert.equal(calls,0);await assert.rejects(dispatch('unknown-prepare',[],{allowUnknownGrid:true},null,()=>false,{pending:()=>['stale']},flow,{}),/unresolved/);assert.equal(calls,0);assert((await dispatch('unknown-prepare',[],{allowUnknownGrid:true},null,()=>false,{pending:()=>[]},flow,{})).ok);assert.equal(calls,1);console.log('formal unknown protocol parity/defaultoff/env/stale checks PASS; no native operations');})().catch(e=>{console.error(e);process.exitCode=1});

// Legacy research compatibility must remove only the formal regions in its private copy.
const {stripFormalUnknown}=require('./unknown-grid-lease-copy-ci');
const stripped=stripFormalUnknown(code);new vm.Script(stripped);
assert(!stripped.includes('// BEGIN formal unknown'));
assert.throws(()=>stripFormalUnknown(stripped));
assert.throws(()=>stripFormalUnknown(code.replace('// END formal unknown dispatch','// broken marker')));
assert(code.includes("config.allowUnknownGrid!==true"));
console.log('PASS strict one-time research-only formal-region removal / JS parse / missing-marker rejection');
