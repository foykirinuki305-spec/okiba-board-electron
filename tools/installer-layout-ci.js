'use strict';
// Real packaged install/update/startup, synthetic data only. No user-data copies.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process'),assert=require('assert/strict');
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('disposable GitHub-hosted Windows only');
const { _electron:electron }=require('playwright');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'okiba-upgrade-layout-')),base=path.join(temp,'boards'),old=path.join(temp,'old'),desktop=path.join(temp,'desktop'),profile=path.join(temp,'profile'),install=path.join(temp,'program'),exe=path.join(install,'OkibaBoard.exe');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),events=[];let app;
async function wait(fn,description){const until=Date.now()+90000;while(Date.now()<until){if(await fn())return;await sleep(250);}throw Error('timeout '+description);}
async function run(file,args){await new Promise((resolve,reject)=>{const p=cp.spawn(file,args,{windowsHide:true,stdio:'inherit',env});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('installer exit '+code)));});}
for(const d of [base,old,desktop,profile])fs.mkdirSync(d,{recursive:true});
const home={positions:{Alpha:{col:3,row:7},Beta:{col:12,row:2}},theme:'dark',appVersion:'1.0.0',future:{nested:['preserve',{x:17}]}};
fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify(home,null,2));
const expected=[];
for(const [name,parent,index] of [['Alpha',base,1],['Beta',base,2],['LegacyImported',old,3]]){
 const folder=path.join(parent,name),linked=path.join(desktop,name+'-linked.txt');fs.mkdirSync(folder);fs.writeFileSync(linked,'linked bytes '+index);fs.writeFileSync(path.join(folder,'resident.txt'),'resident bytes '+index);
 const data={version:6,size_percent:75+index,positions:{'resident.txt':{col:8+index,row:17+index}},links:[{path:linked,col:20+index,row:3+index,wasHidden:true,futureLink:{keep:true}}],notes:[{id:'note-'+index,text:'unchanged',col:2,row:30}],futureBoard:{unknown:[index,{a:true}]}};
 const meta=path.join(folder,'.okiba-board.json');fs.writeFileSync(meta,JSON.stringify(data,null,2));expected.push({name,metaHash:hash(meta),residentHash:hash(path.join(folder,'resident.txt')),linked,linkedHash:hash(linked)});
}
const env={...process.env,OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_SHORTCUT_DESKTOP:desktop,OKIBA_CLEANUP_DESKTOP:desktop,OKIBA_CLEANUP_DOWNLOADS:desktop,OKIBA_TEST_DESKTOP_DIR:desktop,OKIBA_TEST_HOOKS:'1',OKIBA_TEST_HELPER:'fake',OKIBA_TEST_ATTRIB:'stub',ELECTRON_DISABLE_SECURITY_WARNINGS:'1'};
for(const key of ['OKIBA_SELFTEST','OKIBA_LEASE_READONLY_SMOKE','OKIBA_TEST_SNAP_LEASE','ELECTRON_RUN_AS_NODE'])delete env[key];
function verify(phase){
 for(const b of expected){const folder=path.join(base,b.name);assert.equal(hash(path.join(folder,'.okiba-board.json')),b.metaHash,phase+' board metadata '+b.name);assert.equal(hash(path.join(folder,'resident.txt')),b.residentHash);assert.equal(hash(b.linked),b.linkedHash);}
 const actual=JSON.parse(fs.readFileSync(path.join(base,'.home.json'),'utf8'));assert.equal(actual.appVersion,require('../package.json').version);delete actual.appVersion;const want={...home};delete want.appVersion;assert.deepEqual(actual,want,phase+' home positions/unknown fields');events.push({phase,ok:true,boards:expected.map(b=>({name:b.name,sha256:b.metaHash})),home:actual});
}
async function launch(phase){
 app=await electron.launch({executablePath:exe,args:['--no-sandbox','--user-data-dir='+profile],env,timeout:60000});
 try{const page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');
  for(const name of expected.map(b=>b.name)){const board=await page.evaluate(name=>window.okiba.getBoard(name),name);assert(board,'normal renderer board load '+name);
   await page.locator('#boardGrid .board-card[data-name="'+name+'"]').click();await page.waitForSelector('#backBtn',{state:'visible'});await page.waitForSelector('.item .name');await page.click('#backBtn');await page.waitForSelector('#boardGrid .board-card');
  }
  await sleep(500);verify(phase);
 }finally{await app.close();app=null;}
}
(async()=>{try{
 const setup=fs.readdirSync(path.join(root,'dist')).find(n=>/^OkibaBoard-Setup-.*\.exe$/.test(n));assert(setup,'installer missing');
 await run(path.join(root,'dist',setup),['/S','/D='+install]);await wait(()=>fs.existsSync(exe),'initial installed exe');await launch('installed-normal-startup');
 await run(path.join(root,'dist',setup),['/S','/D='+install]);await sleep(2000);await launch('reinstalled-normal-startup');await launch('second-normal-startup-no-migration');
 const uninstall=fs.readdirSync(install).find(n=>/^Uninstall.*\.exe$/i.test(n));assert(uninstall);await run(path.join(install,uninstall),['/S']);await wait(()=>!fs.existsSync(exe),'uninstalled exe');verify('uninstalled-data-retained');
 console.log('INSTALLER LAYOUT all synthetic hashes and positions preserved');
 }finally{if(app)await app.close();const evidence=path.join(root,'installer-layout-evidence');fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({temp,events},null,2));for(const n of ['.home.json','okiba.log'])if(fs.existsSync(path.join(base,n)))fs.copyFileSync(path.join(base,n),path.join(evidence,n.replace(/^\./,'')));}
})().catch(e=>{console.error(e);process.exitCode=1;});
