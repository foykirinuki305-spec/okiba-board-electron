// Builds a disposable copy; never edits the source runtime. Does not execute it.
'use strict';const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
function replaceOnce(s,from,to){assert.equal(s.split(from).length-1,1,'unique patch anchor required: '+from.slice(0,80));return s.replace(from,to);}
// Canonicalize both sides: Windows TEMP may use an 8.3 alias. Every owned
// component must remain below canonical TEMP; junctions/symlinks are rejected.
function ownedTempDirectory(destination,{empty=false,io=fs,paths=path,temp=os.tmpdir()}={}){
 const canonicalTemp=io.realpathSync.native(temp),canonical=io.realpathSync.native(destination);
 const relative=paths.relative(canonicalTemp,canonical);
 assert(relative&&!paths.isAbsolute(relative)&&relative.split(paths.sep).every(n=>n.startsWith('okiba-unknown-ci-')),'owned temp destination only');
 let current=canonicalTemp;
 for(const component of relative.split(paths.sep)){
  current=paths.join(current,component);const st=io.lstatSync(current);
  assert(st.isDirectory()&&!st.isSymbolicLink(),'owned real directory only');
 }
 const original=io.lstatSync(destination);assert(original.isDirectory()&&!original.isSymbolicLink(),'owned real directory only');
 const parent=io.realpathSync.native(paths.dirname(destination));
 assert.equal(paths.relative(parent,canonical),paths.basename(canonical),'canonical parent mismatch');
 if(empty)assert.equal(io.readdirSync(canonical).length,0,'empty owned temp only');
 return canonical;
}
function build(root,destination){
 root=path.resolve(root);destination=ownedTempDirectory(destination,{empty:true});
 for(const name of ['lib','scripts'])fs.cpSync(path.join(root,name),path.join(destination,name),{recursive:true});
 fs.copyFileSync(path.join(root,'tools/unknown-grid-lease-flow-ci.js'),path.join(destination,'lib/unknown-grid-lease-flow-ci.js'));
 fs.copyFileSync(path.join(root,'tools/unknown-grid-lease-native-ci.ps1'),path.join(destination,'scripts/unknown-grid-lease-ci.ps1'));
 let native=fs.readFileSync(path.join(destination,'scripts/snap-lease.ps1'),'utf8');
 native=replaceOnce(native,'  switch($req.cmd){',"  if($req.cmd -like 'leaseUnknown*'){return Invoke-UnknownLeaseCI $req}\n  switch($req.cmd){");
 native+='\n. (Join-Path $PSScriptRoot \'unknown-grid-lease-ci.ps1\')\n';fs.writeFileSync(path.join(destination,'scripts/snap-lease.ps1'),native);
 let client=fs.readFileSync(path.join(destination,'lib/desktop-lease-client.js'),'utf8');
 client=replaceOnce(client,'return {ready,prepareScope:',"return {unknown:(method,...args)=>invoke('unknown-'+method,args),ready,prepareScope:");fs.writeFileSync(path.join(destination,'lib/desktop-lease-client.js'),client);
 let watchdog=fs.readFileSync(path.join(destination,'lib/desktop-lease-watchdog.js'),'utf8');
 watchdog=replaceOnce(watchdog,'async function dispatch(method,args=[]){',`
const unknownFlow=require('./unknown-grid-lease-flow-ci').createUnknownFlow({
 get:()=>active,set:a=>{a.owner=owner;active=a;},ownerState,native,save,
 begin:token=>globalLock.begin({token,journalPath:path.join(journal.dir,token+'.json'),phase:'unknown-preparing',owner,watchdogPid:process.pid,helperHistory}),
 release:token=>globalLock.release(token)
});
async function dispatch(method,args=[]){`);
 watchdog=replaceOnce(watchdog," if(method==='desktopState'){",` if(method.startsWith('unknown-')){
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.OKIBA_UNKNOWN_GRID_CI!=='1')throw Error('unknown-hosted-ci-only');
  const action=method.slice(8);if(action==='prepare')return unknownFlow.prepare(args[0]);if(action==='abort')return unknownFlow.abort(args[0]);return unknownFlow.step(action,args[0],args[1]);
 }
 if(method==='desktopState'){`);
 watchdog=replaceOnce(watchdog,'async function rollback(){',"async function rollback(){\n if(active?.mode==='unknown-ci')return unknownFlow.abort(active.token);");
 watchdog=replaceOnce(watchdog,"await direct('leaseAdopt',{recovery:active.recovery,restorationState:","await direct(active.mode==='unknown-ci'?'leaseUnknownAdopt':'leaseAdopt',{recovery:active.recovery,restorationState:");
 fs.writeFileSync(path.join(destination,'lib/desktop-lease-watchdog.js'),watchdog);
 return {root:destination,helper:path.join(destination,'scripts/shell-helper.ps1'),client:path.join(destination,'lib/desktop-lease-client.js'),scope:'probe/sample/abort prototype only; no unknown success commit support'};
}
module.exports={build,ownedTempDirectory};
