'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process'),assert=require('assert/strict'),{promisify}=require('util');
const policy=require('./packaged-preview-policy-ci');policy.hosted(process.env,process.platform);
const {_electron:electron}=require('playwright'),{createShellHelperClient}=require('../lib/shellhelper'),{stableSnapshot}=require('./stable-snapshot-ci'),{sameSnapshot}=require('../lib/safe-desktop'),{createDesktopLeaseLock}=require('../lib/desktop-lease-global-lock');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'okiba-packaged-preview-')),base=path.join(temp,'boards'),profile=path.join(temp,'profile'),old=path.join(temp,'old'),folder=path.join(base,'Preview');
const report={passed:false,cleanupVerified:false,scope:'packaged preview native IPC resident 3; single known 100%; no settings changes',temp},sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=promisify(cp.execFile),tag='OkibaPreview-'+crypto.randomBytes(12).toString('hex');let app,observer,baseline,files=[],env,desktop,closed=false,terminal=false,ownedProcesses=[];
async function support(action,extra={}){const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'packaged-preview-support-ci.ps1'),'-Action',action],{windowsHide:true,env:{...process.env,...extra}});return JSON.parse(r.stdout);}
async function request(cmd,payload={}){const r=await observer.request(cmd,payload);assert(r.ok&&r.result?.ok,JSON.stringify(r));return r.result;}
function guard(s){if(!baseline)return;assert.equal(s.folderFlags,baseline.folderFlags);for(const i of baseline.icons)assert(s.icons.some(n=>n.identity===i.identity&&n.x===i.x&&n.y===i.y),'old icon changed');}
async function snapshot(cleanup=false){return stableSnapshot({read:()=>observer.request('desktopSnapshot'),guard,same:sameSnapshot,sleep,cleanupEvidence:cleanup?{phase:'terminal-owned-removal',terminalConfirmed:terminal&&closed,record:e=>(report.cleanupReadRetries??=[]).push(e)}:null});}
async function capture(){const all=await support('processes',{OKIBA_PREVIEW_ROOT_PID:String(app.process().pid)}),ids=new Set([app.process().pid]);let changed=true;while(changed){changed=false;for(const p of all)if(ids.has(p.parent)&&!ids.has(p.pid)){ids.add(p.pid);changed=true;}}ownedProcesses=all.filter(p=>ids.has(p.pid));report.processes=ownedProcesses;}
async function stop(){if(!app)return;await capture();await app.close();app=null;const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'wait-owned-processes-ci.ps1')],{windowsHide:true,timeout:120000,env:{...process.env,OKIBA_CHILDREN:JSON.stringify(ownedProcesses)}});report.processExit=JSON.parse(r.stdout);assert(report.processExit.ok);closed=true;}
(async()=>{try{
 const host=await support('environment');desktop=host.desktop;
 observer=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/shell-helper.ps1')],env:policy.cleanEnv(process.env,base,old)});
 baseline=await snapshot();policy.known(baseline);report.baseline=baseline;
 const lock=createDesktopLeaseLock(host);assert(!lock.hasUnresolved(),'unresolved desktop reservation');
 for(const d of [folder,profile,old])fs.mkdirSync(d,{recursive:true});
 const positions={},rows=[3,5,6];for(let n=0;n<3;n++){const name=tag+'-'+(n+1)+'.txt',src=path.join(folder,name);fs.writeFileSync(src,'preview own content '+n,{flag:'wx'});positions[name]={col:2,row:rows[n]};files.push({src,path:path.join(desktop,name),name,bytes:fs.readFileSync(src).toString('base64')});assert(!fs.existsSync(files[n].path));}
 const meta={version:6,size_percent:100,positions,links:[],notes:[],future:{keep:['unchanged']}},metaPath=path.join(folder,'.okiba-board.json');fs.writeFileSync(metaPath,JSON.stringify(meta));fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify({positions:{Preview:{col:2,row:4}},appVersion:require('../package.json').version}));
 for(const f of files){f.record=await request('readHiddenFile',{path:f.src});assert.equal(f.record.attributes,32,'resident Archive-only prerequisite');}
 env=policy.cleanEnv(process.env,base,old);app=await electron.launch({executablePath:path.join(root,'dist/win-unpacked/OkibaBoard.exe'),args:['--no-sandbox','--user-data-dir='+profile],env,timeout:60000});
 const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,profile:app.getPath('userData')}));assert(runtime.packaged);assert.equal(path.resolve(runtime.profile),profile);report.runtime=runtime;
 const page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');await capture();
 report.result=await page.evaluate(payload=>window.okiba.safeTakeout(payload),{boardName:'Preview',paths:files.map(f=>f.src),linkedPaths:[]});policy.success(report.result,files.map(f=>f.src),files.map(f=>f.path));
 const after=await snapshot();report.after=after;assert.equal(after.icons.length,baseline.icons.length+3);
 const icons=files.map(f=>{assert(!fs.existsSync(f.src));assert.equal(fs.readFileSync(f.path).toString('base64'),f.bytes);const i=after.icons.find(i=>i.path?.toLowerCase()===f.path.toLowerCase());assert(i);return i;});const grid=after.areas[0].grid;assert(icons.every(i=>i.x===icons[0].x));assert.equal(icons[1].y-icons[0].y,2*grid.sy);assert.equal(icons[2].y-icons[0].y,3*grid.sy);
 assert.deepEqual(JSON.parse(fs.readFileSync(metaPath)),{...meta,positions:{}});
 for(const f of files){const r=await request('readHiddenFile',{path:f.path});assert.equal(r.identity,f.record.identity);assert.equal(r.size,f.record.size);assert.equal(r.mtime,f.record.mtime);assert.equal(r.attributes,32);}
 const jd=path.join(profile,'desktop-lease-journals'),journals=fs.readdirSync(jd).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(jd,n))));assert.equal(journals.length,1);assert.equal(journals[0].phase,'released');assert.equal(journals[0].outcome,'committed');assert(journals[0].permit&&journals[0].permitDurable);assert.equal(journals[0].receipts.length,1);assert.equal(journals[0].receipts[0].path,metaPath);assert.equal(journals[0].receipts[0].afterHash,crypto.createHash('sha256').update(fs.readFileSync(metaPath)).digest('hex'));assert(!lock.hasUnresolved());report.journals=journals;terminal=true;
 await stop();await snapshot();assert(!lock.hasUnresolved());
 await support('hide',{OKIBA_PREVIEW_TERMINAL:'confirmed',OKIBA_PREVIEW_RECORDS:JSON.stringify(files.map(f=>({path:f.path,...f.record})))});
 let invisible=false;for(let n=0;n<100;n++){const s=await snapshot(true);if(s.icons.length===baseline.icons.length){invisible=true;break;}await sleep(100);}assert(invisible,'owned files not invisible');
 for(const f of files){const r=await request('readHiddenFile',{path:f.path});assert.equal(r.identity,f.record.identity);assert(r.hidden);assert.equal(path.dirname(f.path),desktop);assert(path.basename(f.path).startsWith(tag+'-'));fs.unlinkSync(f.path);}
 const final=await snapshot(true);assert.equal(final.icons.length,baseline.icons.length);report.cleanupVerified=true;report.passed=true;
 }catch(e){report.error=e.stack;throw e;}finally{
  // Fail closed: never delete Desktop items or restore settings on an uncertain result.
  if(app)try{await stop();}catch(e){report.stopError=e.stack;}
  if(observer)report.observerStopped=await observer.stopAndWait(15000);
  const out=path.join(root,'packaged-preview-evidence');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));
  for(const [src,name] of [[path.join(base,'okiba.log'),'okiba.log'],[path.join(folder,'.okiba-board.json'),'board.json']])if(fs.existsSync(src))fs.copyFileSync(src,path.join(out,name));
  if(!report.observerStopped)process.exitCode=1;
 }} )().catch(e=>{console.error(e);process.exitCode=1;});
