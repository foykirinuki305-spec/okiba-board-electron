'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto'),cp=require('child_process'),{promisify}=require('util'),{_electron:electron}=require('playwright');
require('../tools/packaged-preview-policy-ci').hosted(process.env,process.platform);
const ROOT=path.resolve(__dirname,'..'),temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'okiba-packaged-copy-'))),base=path.join(temp,'boards'),folder=path.join(base,'Copy'),profile=path.join(temp,'profile'),old=path.join(temp,'old'),dest=path.join(temp,'chosen'),dest2=path.join(temp,'chosen-two'),external=path.join(temp,'originals'),run=promisify(cp.execFile),out=path.join(ROOT,'packaged-copyout-evidence');
for(const p of [folder,profile,old,dest,dest2,external,out])fs.mkdirSync(p,{recursive:true});
fs.writeFileSync(path.join(temp,'fixture.json'),JSON.stringify({scope:'isolated packaged copy only'}),{flag:'wx'});
const resident=path.join(folder,'resident.txt'),link=path.join(external,'日本語-original.txt'),unsupported=path.join(folder,'unsupported-folder');
fs.mkdirSync(unsupported);fs.writeFileSync(path.join(unsupported,'untouched.txt'),'folder original');
fs.writeFileSync(resident,crypto.randomBytes(128*1024));fs.writeFileSync(link,crypto.randomBytes(192*1024));
const meta=path.join(folder,'.okiba-board.json'),data={version:6,size_percent:100,positions:{'resident.txt':{col:0,row:0},'unsupported-folder':{col:0,row:1}},links:[{path:link,col:1,row:0,wasHidden:false,future:'preserve'}],notes:[],future:{keep:[1,2,3]}};
fs.writeFileSync(meta,JSON.stringify(data));const raw=fs.readFileSync(meta),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),hashes=[resident,link].map(sha);
fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify({appVersion:require('../package.json').version,positions:{Copy:{col:0,row:0}}}));
let app,originalRecords,ownedProcesses=[];const report={passed:false,cases:[],temp,scope:'packaged real copy worker; only chooser is mocked; all material paths generated TEMP; no Desktop operation'};
async function records(paths,action='read'){const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'tools/packaged-copyout-support-ci.ps1'),'-Action',action],{windowsHide:true,env:{...process.env,OKIBA_COPY_FIXTURE:JSON.stringify({root:temp,paths,hidden:link})}});return JSON.parse(r.stdout);}
(async()=>{try{
 const bundle=path.join(ROOT,'dist/win-unpacked/resources/scripts');for(const name of ['copyout.ps1','copyout-native.cs'])assert(fs.readFileSync(path.join(bundle,name)).equals(fs.readFileSync(path.join(ROOT,'scripts',name))),'bundled copy source mismatch');
 originalRecords=await records([resident,link],'prepare');assert.deepEqual(originalRecords.map(r=>r.attributes),[32,34]);report.originalRecords=originalRecords;
 const env={...process.env};for(const k of Object.keys(env))if(/^OKIBA_|^ELECTRON_RUN_AS_NODE$/i.test(k))delete env[k];Object.assign(env,{OKIBA_BASE:base,OKIBA_OLD_BASE:old});
 app=await electron.launch({executablePath:path.join(ROOT,'dist/win-unpacked/OkibaBoard.exe'),args:['--no-sandbox','--user-data-dir='+profile],env,timeout:60000});
 report.runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,profile:app.getPath('userData'),exe:process.execPath,pid:process.pid,resources:process.resourcesPath}));assert(report.runtime.packaged);assert.equal(path.resolve(report.runtime.profile),profile);
 const page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');await page.locator('#boardGrid .board-card').first().dblclick();await page.waitForSelector('#boardArea .item');
 await app.evaluate(({app,dialog},choice)=>{
  const p=process.mainModule.require('path'),module=process.mainModule.require(p.join(app.getAppPath(),'lib/copyout.js')),real=module.copyFilesOut;
  global.__packagedCopy={cancel:true,dest:choice,dialogs:0,calls:[]};
  dialog.showOpenDialog=async(_w,options)=>{const s=global.__packagedCopy;s.dialogs++;s.options=options;return s.cancel?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[s.dest]};};
  module.copyFilesOut=async args=>{const r=await real(args);global.__packagedCopy.calls.push({args,result:r});return r;};
 },dest);
 const state=()=>app.evaluate(()=>({dialogs:global.__packagedCopy.dialogs,calls:global.__packagedCopy.calls,options:global.__packagedCopy.options})),item=k=>page.locator('[data-key='+JSON.stringify(k)+']');
 async function choose(cancel,d){await app.evaluate((_,v)=>{global.__packagedCopy.cancel=v.cancel;global.__packagedCopy.dest=v.dest;},{cancel,dest:d});}
 async function copy(){await item('file:resident.txt').click({button:'right'});await page.locator('#ctxMenu').getByText('原本を残してコピー…',{exact:true}).click();}
 async function originals(n){assert.deepEqual(fs.readFileSync(meta),raw);assert.deepEqual(await records([resident,link]),originalRecords);assert.deepEqual([resident,link].map(sha),hashes);assert.equal(fs.readFileSync(path.join(unsupported,'untouched.txt'),'utf8'),'folder original');assert.equal(await page.locator('.item.selected').count(),n);}
 await item('file:resident.txt').click();await item('link:'+link).click({modifiers:['Control']});
 await copy();await page.waitForTimeout(250);assert.equal((await state()).calls.length,0);assert.deepEqual(fs.readdirSync(dest),[]);await originals(2);report.cases.push('cancel-no-copy');
 await choose(false,dest);await copy();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('コピー完了 2件'),null,{timeout:120000});
 const first=(await state()).calls[0];assert.equal(first.result.copied.length,2);assert.equal(first.result.partial.length,0);assert.equal(path.resolve(first.args.scriptPath),path.join(bundle,'copyout.ps1'));assert.deepEqual(first.args.sources,[resident,link]);
 const destinations=[resident,link].map(p=>path.join(dest,path.basename(p))),copiedRecords=await records(destinations);assert.deepEqual(destinations.map(sha),hashes);assert(copiedRecords.every((r,n)=>r.attributes===32&&r.identity!==originalRecords[n].identity));await originals(2);report.cases.push('bundled-native-visible-copy-original-hidden-retained');
 await copy();await page.waitForFunction(()=>globalThis.document.querySelector('#toast').textContent.includes('スキップ 2件'));assert.equal((await state()).calls.length,2);assert.equal((await state()).calls[1].result.skipped.length,2);assert.deepEqual(await records(destinations),copiedRecords);await originals(2);report.cases.push('existing-destination-not-overwritten');
 await item('file:unsupported-folder').click();await item('file:unsupported-folder').click({button:'right'});await page.locator('#ctxMenu').getByText('原本を残してコピー…',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('未完了 1件'));const failure=(await state()).calls[2].result;assert.equal(failure.copied.length,0);assert.equal(failure.failed.length,1);await originals(1);report.cases.push('folder-rejected-without-move');
 await item('link:'+link).click();await choose(false,dest2);await item('link:'+link).click({button:'right'});await page.locator('#ctxMenu').getByText('原本を残してコピー…',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('コピー完了 1件'),null,{timeout:120000});assert.equal(sha(path.join(dest2,path.basename(link))),hashes[1]);assert.equal((await records([path.join(dest2,path.basename(link))]))[0].attributes,32);await originals(1);report.cases.push('explicit-copy-after-failure-to-second-folder');
 assert(fs.readdirSync(dest).every(n=>destinations.some(p=>path.basename(p)===n)));assert.equal(fs.readdirSync(dest2).length,1);
 report.state=await state();await page.screenshot({path:path.join(out,'copy-success.png')});report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}finally{
 if(app){try{
 const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'tools/packaged-preview-support-ci.ps1'),'-Action','processes'],{windowsHide:true,env:{...process.env,OKIBA_PREVIEW_ROOT_PID:String(app.process().pid)}});ownedProcesses=JSON.parse(r.stdout);report.processes=ownedProcesses;
 await app.close();app=null;const stopped=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'tools/wait-owned-processes-ci.ps1')],{windowsHide:true,timeout:120000,env:{...process.env,OKIBA_CHILDREN:JSON.stringify(ownedProcesses)}});report.processExit=JSON.parse(stopped.stdout);assert(report.processExit.ok);
 }catch(e){report.stopError=e.stack;report.passed=false;process.exitCode=1;}}
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));
}})();
