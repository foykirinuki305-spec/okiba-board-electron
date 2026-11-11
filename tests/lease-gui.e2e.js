'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('GUI lease test is hosted Windows CI only; no real user Desktop');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {_electron:electron}=require('playwright');const ROOT=path.resolve(__dirname,'..');
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;console.log('ok '+m);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const end=Date.now()+25000;while(Date.now()<end){try{if(await fn())return;}catch{}await sleep(100);}throw Error('timeout: '+label);}
async function scenario(mode){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-lease-gui-'));const base=path.join(temp,'boards'),board=path.join(base,'Lease'),desktop=path.join(temp,'desktop'),old=path.join(temp,'old'),profile=path.join(temp,'profile');for(const p of [board,desktop,old])fs.mkdirSync(p,{recursive:true});
 const files=['first.txt','second.txt'].map(n=>path.join(desktop,n));files.forEach((p,i)=>fs.writeFileSync(p,'selected-'+i));
 const keep=path.join(board,'keep.txt');fs.writeFileSync(keep,'unchanged resident');const sentinel=path.join(desktop,'sentinel.txt');fs.writeFileSync(sentinel,'untouched');const sentinelStat=fs.statSync(sentinel);
 const meta=path.join(board,'.okiba-board.json');fs.writeFileSync(meta,JSON.stringify({version:6,positions:{'keep.txt':{col:1,row:1}},notes:[],links:[],size_percent:100}));
 fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify({appVersion:require('../package.json').version,positions:{Lease:{col:0,row:0}},theme:'light'}));
 const log=path.join(temp,'lease.jsonl');const records=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const snapshot={ok:true,identityVersion:1,autoArrange:false,snap:true,sx:100,sy:100,gx:0,gy:0,origin:{x:0,y:0},areas:[{left:0,top:0,right:3000,bottom:2000,grid:{gx:0,gy:0,sx:100,sy:100}}],icons:[{identity:'old-sentinel',label:'sentinel.txt',path:sentinel,x:2000,y:1000}]};
 const env={...process.env,OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_SHORTCUT_DESKTOP:desktop,OKIBA_CLEANUP_DESKTOP:desktop,OKIBA_CLEANUP_DOWNLOADS:desktop,OKIBA_TEST_DESKTOP_DIR:desktop,OKIBA_TEST_HOOKS:'1',OKIBA_TEST_ATTRIB:'stub',OKIBA_TEST_HELPER:'fake',OKIBA_TEST_SNAP_LEASE:'1',OKIBA_TEST_POSITIONER:'',OKIBA_TEST_RESOLVER_DIR:'',OKIBA_FAKE_LANDING:desktop,OKIBA_FAKE_TYPE:'desktop',OKIBA_TEST_DESKTOP_SNAPSHOT:JSON.stringify(snapshot),OKIBA_FAKE_LEASE:'1',OKIBA_FAKE_LEASE_ROOT:temp,OKIBA_FAKE_LEASE_LOG:log,OKIBA_FAKE_LEASE_MODE:mode,ELECTRON_DISABLE_SECURITY_WARNINGS:'1'};
 let app,clean=false;
 try{
  app=await electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+profile],env,timeout:60000});const page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');await page.click('#boardGrid .board-card[data-name="Lease"]');
  await page.evaluate(paths=>window.okiba.linkFiles('Lease',paths,{anchor:[3,1],offsets:[[0,0],[0,1]]}),files);
  const card=n=>page.locator('.item').filter({has:page.locator('.name',{hasText:n})}).first();
  await wait(async()=>(await page.locator('.item .name').allTextContents()).includes('first.txt'),'linked cards');await sleep(500);
  // Install a future-version field after normal intake, so the tested commit must retain it.
  const data=JSON.parse(fs.readFileSync(meta,'utf8'));data.future={untouched:['value',17]};fs.writeFileSync(meta,JSON.stringify(data));await sleep(500);
  const before=fs.readFileSync(meta,'utf8'),beforeData=JSON.parse(before);const keptBox=await card('keep.txt').boundingBox();
  await card('first.txt').click({button:'right'});await page.getByText('デスクトップへ移動',{exact:true}).click();
  await wait(()=>records().some(r=>r.cmd==='leasePrepare'),'real Node watchdog reached fake helper');
  if(mode==='reveal-fail'){
   await wait(()=>records().some(r=>r.cmd==='fake-terminal'&&r.visible===false),'rollback terminal');await wait(async()=>(await page.locator('.item .name').allTextContents()).includes('first.txt'),'failure card restored');
   check(fs.readFileSync(meta,'utf8')===before,'failed lease retains full metadata bytes');check(!fs.existsSync(path.join(base,'.move-history.json')),'failed lease no history');check(await card('first.txt').count()===1,'failed item remains visible on board');
  }else{
   await wait(()=>JSON.parse(fs.readFileSync(meta,'utf8')).links.length===1,'selected metadata commit');await wait(async()=>!(await page.locator('.item .name').allTextContents()).includes('first.txt'),'committed card gone');
   const after=JSON.parse(fs.readFileSync(meta,'utf8'));for(const k of Object.keys(beforeData).filter(k=>k!=='links'))check(JSON.stringify(after[k])===JSON.stringify(beforeData[k]),'preserved '+k);
   if(mode==='pending'){
    await wait(async()=>(await page.locator('#toast').innerText()).includes('確認中'),'pending message');
    const prepares=records().filter(r=>r.cmd==='leasePrepare').length;
    const retry=await page.evaluate(p=>window.okiba.safeTakeout({boardName:'Lease',paths:[],linkedPaths:[p]}),files[1]);
    check(retry.pendingVerification===true&&retry.retrySafe===false,'pending retry is explicitly blocked');check(records().filter(r=>r.cmd==='leasePrepare').length===prepares,'pending retry starts no new lease');check(!fs.existsSync(path.join(base,'.move-history.json')),'pending does not claim history success');
   }else{
    await wait(()=>fs.existsSync(path.join(base,'.move-history.json')),'success history');check(records().some(r=>r.cmd==='fake-terminal'&&r.visible===true),'success visible terminal');
    await card('second.txt').click({button:'right'});await page.getByText('デスクトップへ移動',{exact:true}).click();await wait(()=>JSON.parse(fs.readFileSync(meta,'utf8')).links.length===0,'second warm transaction');
    check(new Set(records().filter(r=>r.cmd==='leasePrepare').map(r=>r.pid)).size===1,'two transactions reuse dedicated helper');
   }
  }
  const afterBox=await card('keep.txt').boundingBox();check(keptBox.x===afterBox.x&&keptBox.y===afterBox.y,'existing resident card stays at same position');check(fs.readFileSync(keep,'utf8')==='unchanged resident','resident original bytes unchanged');check(fs.statSync(sentinel).mtimeMs===sentinelStat.mtimeMs&&fs.readFileSync(sentinel,'utf8')==='untouched','unrelated desktop fixture unchanged');
  for(let i=0;i<files.length;i++)check(fs.readFileSync(files[i],'utf8')==='selected-'+i,'selected original file bytes unchanged');
 }finally{
  if(app)await app.close();
  const pids=[...new Set(records().filter(r=>r.cmd==='fake-start').flatMap(r=>[r.pid,r.parent]))];
  await wait(()=>pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'owned helper/watchdog termination');clean=true;
  const evidence=path.join(ROOT,'lease-gui-evidence');fs.mkdirSync(evidence,{recursive:true});fs.cpSync(temp,path.join(evidence,mode),{recursive:true});
  if(clean){const resolved=path.resolve(temp);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('okiba-lease-gui-'));fs.rmSync(resolved,{recursive:true,force:true});}
 }
}
(async()=>{for(const mode of ['success','reveal-fail','pending'])await scenario(mode);console.log('LEASE GUI '+checks+' checks PASS');})().catch(e=>{console.error(e);process.exitCode=1;});
