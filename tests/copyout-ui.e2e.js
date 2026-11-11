'use strict';
// Real Electron renderer + mocked dialog/copy worker, generated TEMP board only.
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('hosted isolated GUI only');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{_electron:electron}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-copy-ui-')),base=path.join(temp,'boards'),folder=path.join(base,'Copy'),profile=path.join(temp,'profile'),old=path.join(temp,'old'),dest=path.join(temp,'chosen');
for(const p of [folder,profile,old,dest])fs.mkdirSync(p,{recursive:true});
const resident=path.join(folder,'resident.txt'),link=path.join(temp,'original.txt');fs.writeFileSync(resident,'resident original');fs.writeFileSync(link,'linked original');
const meta=path.join(folder,'.okiba-board.json'),data={version:6,size_percent:100,positions:{'resident.txt':{col:0,row:0}},links:[{path:link,col:1,row:0,wasHidden:false,future:'preserve'}],notes:[],future:{keep:[1,2,3]}};
fs.writeFileSync(meta,JSON.stringify(data));const raw=fs.readFileSync(meta),content=fs.readFileSync(link),residentContent=fs.readFileSync(resident);
fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify({appVersion:require('../package.json').version,positions:{Copy:{col:0,row:0}}}));
let app;const out=path.join(ROOT,'copyout-ui-evidence');fs.mkdirSync(out,{recursive:true});const evidence={passed:false,cases:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 const env={...process.env,OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_TEST_HOOKS:'1',OKIBA_TEST_ATTRIB:'stub',OKIBA_SHORTCUT_DESKTOP:dest,OKIBA_CLEANUP_DESKTOP:dest,OKIBA_CLEANUP_DOWNLOADS:dest};
 delete env.OKIBA_DESKTOP_SAFE_PREVIEW;delete env.OKIBA_DESKTOP_UNKNOWN_PREVIEW;
 app=await electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+profile],env});
 const page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');await page.locator('#boardGrid .board-card').first().dblclick();await page.waitForSelector('#boardArea .item');
 await app.evaluate(({app,dialog},dest)=>{
  const nativeModule=process.getBuiltinModule('module'),nativePath=process.getBuiltinModule('path');
  const requireFromApp=nativeModule.createRequire(nativePath.join(app.getAppPath(),'package.json'));
  const module=requireFromApp('./lib/copyout.js');
  global.__copyUi={mode:'cancel',dialogs:0,copies:0,inputs:[],dest};
  dialog.showOpenDialog=async(_window,options)=>{const s=global.__copyUi;s.dialogs++;s.options=options;if(s.mode==='hold')return new Promise(r=>{s.release=r;});return s.mode==='cancel'?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[dest]};};
  module.copyFilesOut=async args=>{const s=global.__copyUi;s.copies++;s.inputs.push(args);if(s.mode==='fail')return {copied:[],skipped:[],failed:args.sources.map(src=>({src,reason:'fixture-failure',cleanupVerified:true})),partial:[]};if(s.mode==='partial')return {copied:[],skipped:[],failed:[],partial:args.sources.map(src=>({src,reason:'visibility-unverified',partialPath:dest}))};return {copied:args.sources.map(src=>({src,dest})),skipped:[],failed:[],partial:[]};};
 },dest);
 const stats=()=>app.evaluate(()=>({dialogs:global.__copyUi.dialogs,copies:global.__copyUi.copies,mode:global.__copyUi.mode,options:global.__copyUi.options}));
 async function mode(m){await app.evaluate((_,v)=>{global.__copyUi.mode=v;},m);}
 async function unchanged(){assert.deepEqual(fs.readFileSync(meta),raw);assert.deepEqual(fs.readFileSync(link),content);assert.deepEqual(fs.readFileSync(resident),residentContent);assert.deepEqual(fs.readdirSync(dest),[]);assert.equal(await page.locator('.item.selected').count(),2);}
 const item=p=>page.locator('[data-key='+JSON.stringify(p)+']');
 await item('file:resident.txt').click();await item('link:'+link).click({modifiers:['Control']});
 async function clickCopy(){await item('file:resident.txt').click({button:'right'});await page.locator('#ctxMenu').getByText('原本を残してコピー…',{exact:true}).click();}
 await clickCopy();await sleep(200);assert.equal((await stats()).copies,0);assert.equal((await stats()).dialogs,1);assert.deepEqual((await stats()).options.properties,['openDirectory']);await unchanged();evidence.cases.push('cancel-no-worker-no-change');
 await mode('fail');await clickCopy();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('未完了 2件'));await unchanged();evidence.cases.push('failure-keeps-selection-and-metadata');
 await mode('success');await clickCopy();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('コピー完了 2件'));await unchanged();evidence.cases.push('explicit-retry-after-failure-stub-success-originals-stay');
 await mode('hold');await clickCopy();await sleep(100);const before=await stats();await clickCopy();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('コピー処理中'));assert.equal((await stats()).dialogs,before.dialogs);await app.evaluate(()=>global.__copyUi.release({canceled:true,filePaths:[]}));await sleep(100);await unchanged();evidence.cases.push('repeated-action-while-dialog-held-no-second-worker');
 await mode('partial');await clickCopy();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('確認するまで再実行しない'));await unchanged();evidence.cases.push('unresolved-partial-not-success');
 evidence.stats=await stats();await page.screenshot({path:path.join(out,'copy-partial.png')});evidence.passed=true;
}catch(e){evidence.error=e.stack;process.exitCode=1;}finally{if(app)await app.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(evidence,null,2));}})();
