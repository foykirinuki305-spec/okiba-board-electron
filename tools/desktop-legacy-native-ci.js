'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{fork,execFile}=require('child_process'),{promisify}=require('util');
const {createShellHelperClient}=require('../lib/shellhelper'),{createDesktopLeaseLock}=require('../lib/desktop-lease-global-lock'),{sameSnapshot}=require('../lib/safe-desktop');
const run=promisify(execFile),root=path.resolve(__dirname,'..'),report={passed:false,cleanupVerified:false,scope:'Hosted CI only. Legacy reservation has NO Desktop mutation commands. Explicit fixture-only stale pointer cleanup after confirmed process termination and unchanged Desktop.'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-legacy-native-')),children=[];
 const helperPath=path.join(root,'scripts/shell-helper.ps1'),observer=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helperPath],env:{...process.env,OKIBA_SNAP_LEASE:'1'},timeoutMs:20000});
 const request=async(cmd,args={})=>{const r=await observer.request(cmd,args);assert(r.ok&&r.result?.ok,JSON.stringify(r));return r.result;};
 const stable=async()=>{let previous;for(let i=0;i<80;i++){const s=await request('desktopSnapshot');if(previous&&sameSnapshot(previous,s))return s;previous=s;await sleep(100);}throw Error('unstable Desktop');};
 const ask=(c,m)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('owner timeout')),45000);c.once('message',r=>{clearTimeout(t);r.phase==='error'?reject(Error(r.error)):resolve(r);});c.send(m);});
 const spawnOwner=()=>{const c=fork(path.join(root,'tools/desktop-lease-protocol-host-ci.js'),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(c);return c;};
 async function stopOwner(c){if(c.exitCode!==null||c.signalCode!==null)return;const end=new Promise(r=>c.once('exit',r));c.kill();await Promise.race([end,sleep(5000)]);assert(c.exitCode!==null||c.signalCode!==null,'owner stop unconfirmed');}
 async function nativeProcess(pid,started){const code="$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById([int]$env:OKIBA_FIXTURE_PID);$null=$p.Handle;$birth=$p.StartTime.ToUniversalTime().Ticks.ToString();if($env:OKIBA_FIXTURE_BIRTH){if($birth -cne $env:OKIBA_FIXTURE_BIRTH){throw 'PID reused'};$p.Kill();if(-not $p.WaitForExit(5000)){throw 'stop unconfirmed'}};Write-Output $birth";return (await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:15000,env:{...process.env,OKIBA_FIXTURE_PID:String(pid),OKIBA_FIXTURE_BIRTH:started||''}})).stdout.trim();}
 async function attributes(snapshot){const paths=snapshot.icons.map(i=>i.path).filter(p=>p&&fs.existsSync(p));const code="$ErrorActionPreference='Stop';@((ConvertFrom-Json $env:OKIBA_FIXTURE_PATHS)|ForEach-Object{@($_,[int][IO.File]::GetAttributes($_))})|ConvertTo-Json -Depth 5 -Compress";return (await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:15000,env:{...process.env,OKIBA_FIXTURE_PATHS:JSON.stringify(paths)}})).stdout.trim();}
 try{
  const identity=await request('leaseHelperIdentity'),before=await stable(),attrsBefore=await attributes(before);assert(before.identityVersion===1);
  const lock=createDesktopLeaseLock(identity);assert(!lock.hasUnresolved(),'prior global pointer must not be touched');
  const journalDir=path.join(temp,'owner-journal'),spec={desktop:identity.desktop,helperPath,journalDir};const owner=spawnOwner();
  const reservation=await ask(owner,{cmd:'legacy',spec});assert(reservation.result.ok);const token=reservation.result.token;report.reservation=reservation;
  const watchdogPid=reservation.watchdog.pid,watchdogBirth=await nativeProcess(watchdogPid),nativeHelper=reservation.status.helper.history.at(-1);
  assert.equal(nativeHelper.pid,nativeHelper.spawnPid);assert(!reservation.status.nativeTimings.some(t=>['leasePrepare','leaseRevealPlace','leaseRollback'].includes(t.command)));
  const pointerBefore=JSON.parse(fs.readFileSync(lock.pointer,'utf8'));assert.equal(pointerBefore.token,token);assert.equal(pointerBefore.journalPath,path.join(journalDir,token+'.json'));
  await stopOwner(owner);
  const journalPath=path.join(journalDir,token+'.json');let journal;for(let n=0;n<150;n++){journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));if(journal.phase==='blocked')break;await sleep(100);}assert.equal(journal.phase,'blocked');assert.equal(journal.mode,'legacy-reservation');assert.equal(journal.lastError,'legacy-owner-exited-operation-state-unknown');assert(lock.hasUnresolved());report.ownerDeathJournal=journal;
  const contender=spawnOwner();const denial=await ask(contender,{cmd:'legacy',spec:{...spec,journalDir:path.join(temp,'different-BASE')}});assert.equal(denial.result.ok,false);assert(/desktop-lease-busy|unresolved-global-desktop-lease/.test(denial.result.reason));report.contender=denial;assert((await ask(contender,{cmd:'close'})).result.ok);await stopOwner(contender);
  // Only this hosted fixture may retire its deliberately abandoned, NO-MUTATION reservation.
  // Never add this cleanup path to production. Stop both independently pinned processes first.
  await nativeProcess(watchdogPid,watchdogBirth);await nativeProcess(nativeHelper.pid,nativeHelper.started);report.stopped={watchdog:{pid:watchdogPid,started:watchdogBirth},helper:nativeHelper};
  const after=await stable();assert(sameSnapshot(before,after));assert.equal(await attributes(before),attrsBefore);report.desktopUnchanged=true;report.attributesUnchanged=true;
  const pointerAfter=JSON.parse(fs.readFileSync(lock.pointer,'utf8'));assert.equal(pointerAfter.token,token);assert.equal(pointerAfter.journalPath,journalPath);assert.equal(pointerAfter.phase,'blocked');
  assert(!fs.readdirSync(path.dirname(lock.pointer)).some(n=>n.startsWith(lock.key+'.')&&n.endsWith('.tmp')),'unresolved write temp prohibits cleanup');report.fixturePointerRemoved=pointerAfter;
  fs.writeFileSync(path.join(root,'desktop-legacy-native-ci.json'),JSON.stringify(report,null,2));fs.unlinkSync(lock.pointer);assert(!lock.hasUnresolved());report.cleanupVerified=true;report.passed=true;
 }finally{
  for(const c of children)await stopOwner(c);
  assert(await observer.stopAndWait(10000),'observer stop unconfirmed');
  fs.writeFileSync(path.join(root,'desktop-legacy-native-ci.json'),JSON.stringify(report,null,2));
  if(report.cleanupVerified){assert(path.basename(temp).startsWith('okiba-legacy-native-'));fs.rmSync(temp,{recursive:true,force:true});}
 }
}
main().catch(e=>{report.error=String(e.stack||e);fs.writeFileSync(path.join(root,'desktop-legacy-native-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
