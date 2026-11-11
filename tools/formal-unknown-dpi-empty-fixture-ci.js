'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const names=new Set(['Firefox.lnk','Google Chrome.lnk','Microsoft Edge.lnk','R 4.6.2.lnk','Unity Hub.lnk']);
function allowed(file,common){return typeof file==='string'&&path.win32.dirname(file).toLowerCase()===common.toLowerCase()&&names.has(path.win32.basename(file));}
async function waitForEmpty(read,check,{attempts=20,sleep=ms=>new Promise(r=>setTimeout(r,ms)),observe=()=>{}}={}){
 for(let n=0;n<attempts;n++){await check();const value=await read();observe(value);if(!value?.ok){if(value?.reason!=='desktop-changing')throw Error('empty-snapshot-unavailable:'+JSON.stringify(value));}else if(value.icons.length===0)return value;await sleep(250);}throw Error('empty-snapshot-timeout');
}
module.exports={allowed,waitForEmpty};
if(require.main===module){(async()=>{
 assert(process.platform==='win32'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_OS==='Windows'&&process.env.RUNNER_ENVIRONMENT==='github-hosted','hosted only');
 const root=path.resolve(__dirname,'..'),journal=path.join(root,'formal-unknown-dpi-empty-fixture.json'),common=path.join(process.env.PUBLIC,'Desktop'),action=process.argv[2];
 const copy=fs.mkdtempSync(path.join(require('os').tmpdir(),'okiba-empty-readonly-'));fs.cpSync(path.join(root,'scripts'),path.join(copy,'scripts'),{recursive:true});const helper=path.join(copy,'scripts','shell-helper.ps1');let source=fs.readFileSync(helper,'utf8');const anchor="'desktopSnapshot'     { $result = Get-StrictDesktopSnapshot }";assert.equal(source.split(anchor).length,2);source=source.replace(anchor,"'desktopSnapshot'     { $result = Get-StrictDesktopSnapshot; $result.fixtureHiddenPreference=[Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced','Hidden',$null) }");fs.writeFileSync(helper,source);
 const h=require('../lib/shellhelper').createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],timeoutMs:15000});
 const call=async(cmd,p={})=>{const r=await h.request(cmd,p);assert(r.ok&&r.result?.ok,JSON.stringify(r));return r.result;};
 const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 const save=m=>{const fd=fs.openSync(journal,'w');try{fs.writeFileSync(fd,JSON.stringify(m,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 let m;
 try{
 if(action==='hide'){
  assert(!fs.existsSync(journal),'do not overwrite prior fixture journal');const before=await call('desktopSnapshot');assert(before.snap&&!before.autoArrange&&!before.shellAutoArrange&&before.fixtureHiddenPreference===2,'snap/auto-arrange/hidden-view precondition');m={scope:'hosted fixture preparation, NOT protection of old icons',phase:'prepared',before,records:[]};
  for(const icon of before.icons){if(!icon.path){assert(icon.label==='Recycle Bin','unknown virtual icon');continue;}assert(allowed(icon.path,common),'unapproved desktop file');const st=fs.lstatSync(icon.path);assert(st.isFile()&&!st.isSymbolicLink());const n=await call('readHiddenFile',{path:icon.path});assert(!n.directory&&!n.hidden&&(n.attributes&1024)===0);m.records.push({path:icon.path,...n,hash:hash(icon.path),attempted:false});}
  save(m);for(const r of m.records){r.attempted=true;save(m);assert.equal(hash(r.path),r.hash);await call('setHiddenFile',{path:r.path,expectedIdentity:r.identity,expectedHidden:false,hidden:true});}m.phase='hidden';save(m);
 }else if(action==='empty'){
 m=JSON.parse(fs.readFileSync(journal,'utf8'));m.emptyObservations=[];
 const s=await waitForEmpty(async()=>{const v=await h.request('desktopSnapshot',{});assert(v.ok,JSON.stringify(v));return v.result;},async()=>{for(const r of m.records){const n=await call('readHiddenFile',{path:r.path});assert(n.identity===r.identity&&n.hidden&&hash(r.path)===r.hash,'hidden identity changed');}}, {observe:v=>{m.emptyObservations.push(v);save(m);}});
 fs.writeFileSync(path.join(root,'dpi-empty-baseline.json'),JSON.stringify(s,null,2));}
 else if(action==='restore'){
  m=JSON.parse(fs.readFileSync(journal,'utf8'));for(const r of m.records){assert(allowed(r.path,common));if(!r.attempted)continue;assert.equal(hash(r.path),r.hash);const n=await call('readHiddenFile',{path:r.path});assert.equal(n.identity,r.identity);assert.equal(n.attributes&~130,r.attributes&~130);if(n.hidden)await call('setHiddenFile',{path:r.path,expectedIdentity:r.identity,expectedHidden:true,hidden:r.hidden});const after=await call('readHiddenFile',{path:r.path});assert.equal(after.attributes,r.attributes);}
  m.phase='attributes-restored';save(m);
 }else if(action==='verify'){
  m=JSON.parse(fs.readFileSync(journal,'utf8'));m.restoreObservations=[];
  for(let attempt=0;attempt<20;attempt++){
   for(const r of m.records){const n=await call('readHiddenFile',{path:r.path});assert(n.identity===r.identity&&n.attributes===r.attributes&&hash(r.path)===r.hash,'restored file changed');}
   m.after=await call('desktopSnapshot');m.restoreObservations.push(m.after);save(m);
   const moved=m.before.icons.filter(i=>m.after.icons.some(j=>j.identity===i.identity&&(j.x!==i.x||j.y!==i.y)));
   if(moved.length)break;
   if(m.before.icons.every(i=>m.after.icons.some(j=>j.identity===i.identity&&j.x===i.x&&j.y===i.y)))break;
   await new Promise(r=>setTimeout(r,250));
  }
  m.oldIconDifferences=m.before.icons.filter(i=>!m.after.icons.some(j=>i.identity===j.identity&&i.x===j.x&&i.y===j.y));m.phase=m.oldIconDifferences.length?'fixture-restoration-unverified':'fixture-restored';save(m);assert.equal(m.oldIconDifferences.length,0,'fixture positions changed; not concealed');
 }else throw Error('unknown action');
 }catch(e){if(m){m.error=e.stack;save(m);}throw e;}finally{assert(await h.stopAndWait(10000),'helper stop unconfirmed');}
})().catch(e=>{console.error(e);process.exitCode=1;});}
